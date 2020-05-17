'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var vue = require('vue');
var shared = require('@vue/shared');
var compilerSsr = require('@vue/compiler-ssr');

const shouldIgnoreProp = shared.makeMap(`key,ref,innerHTML,textContent`);
function ssrRenderAttrs(props, tag) {
    let ret = '';
    for (const key in props) {
        if (shouldIgnoreProp(key) ||
            shared.isOn(key) ||
            (tag === 'textarea' && key === 'value')) {
            continue;
        }
        const value = props[key];
        if (key === 'class') {
            ret += ` class="${ssrRenderClass(value)}"`;
        }
        else if (key === 'style') {
            ret += ` style="${ssrRenderStyle(value)}"`;
        }
        else {
            ret += ssrRenderDynamicAttr(key, value, tag);
        }
    }
    return ret;
}
// render an attr with dynamic (unknown) key.
function ssrRenderDynamicAttr(key, value, tag) {
    if (!isRenderableValue(value)) {
        return ``;
    }
    const attrKey = tag && tag.indexOf('-') > 0
        ? key // preserve raw name on custom elements
        : shared.propsToAttrMap[key] || key.toLowerCase();
    if (shared.isBooleanAttr(attrKey)) {
        return value === false ? `` : ` ${attrKey}`;
    }
    else if (shared.isSSRSafeAttrName(attrKey)) {
        return value === '' ? ` ${attrKey}` : ` ${attrKey}="${shared.escapeHtml(value)}"`;
    }
    else {
        console.warn(`[@vue/server-renderer] Skipped rendering unsafe attribute name: ${attrKey}`);
        return ``;
    }
}
// Render a v-bind attr with static key. The key is pre-processed at compile
// time and we only need to check and escape value.
function ssrRenderAttr(key, value) {
    if (!isRenderableValue(value)) {
        return ``;
    }
    return ` ${key}="${shared.escapeHtml(value)}"`;
}
function isRenderableValue(value) {
    if (value == null) {
        return false;
    }
    const type = typeof value;
    return type === 'string' || type === 'number' || type === 'boolean';
}
function ssrRenderClass(raw) {
    return shared.escapeHtml(shared.normalizeClass(raw));
}
function ssrRenderStyle(raw) {
    if (!raw) {
        return '';
    }
    if (shared.isString(raw)) {
        return shared.escapeHtml(raw);
    }
    const styles = shared.normalizeStyle(raw);
    return shared.escapeHtml(shared.stringifyStyle(styles));
}

function ssrRenderTeleport(parentPush, contentRenderFn, target, disabled, parentComponent) {
    parentPush('<!--teleport start-->');
    let teleportContent;
    if (disabled) {
        contentRenderFn(parentPush);
        teleportContent = `<!---->`;
    }
    else {
        const { getBuffer, push } = createBuffer();
        contentRenderFn(push);
        push(`<!---->`); // teleport end anchor
        teleportContent = getBuffer();
    }
    const context = parentComponent.appContext.provides[vue.ssrContextKey];
    const teleportBuffers = context.__teleportBuffers || (context.__teleportBuffers = {});
    if (teleportBuffers[target]) {
        teleportBuffers[target].push(teleportContent);
    }
    else {
        teleportBuffers[target] = [teleportContent];
    }
    parentPush('<!--teleport end-->');
}

const { isVNode, createComponentInstance, setCurrentRenderingInstance, setupComponent, renderComponentRoot, normalizeVNode, normalizeSuspenseChildren } = vue.ssrUtils;
function createBuffer() {
    let appendable = false;
    let hasAsync = false;
    const buffer = [];
    return {
        getBuffer() {
            // If the current component's buffer contains any Promise from async children,
            // then it must return a Promise too. Otherwise this is a component that
            // contains only sync children so we can avoid the async book-keeping overhead.
            return hasAsync ? Promise.all(buffer) : buffer;
        },
        push(item) {
            const isStringItem = shared.isString(item);
            if (appendable && isStringItem) {
                buffer[buffer.length - 1] += item;
            }
            else {
                buffer.push(item);
            }
            appendable = isStringItem;
            if (!isStringItem && !shared.isArray(item)) {
                // promise
                hasAsync = true;
            }
        }
    };
}
function unrollBuffer(buffer) {
    let ret = '';
    for (let i = 0; i < buffer.length; i++) {
        const item = buffer[i];
        if (shared.isString(item)) {
            ret += item;
        }
        else {
            ret += unrollBuffer(item);
        }
    }
    return ret;
}
async function renderToString(input, context = {}) {
    if (isVNode(input)) {
        // raw vnode, wrap with app (for context)
        return renderToString(vue.createApp({ render: () => input }), context);
    }
    // rendering an app
    const vnode = vue.createVNode(input._component, input._props);
    vnode.appContext = input._context;
    // provide the ssr context to the tree
    input.provide(vue.ssrContextKey, context);
    const buffer = await renderComponentVNode(vnode);
    await resolveTeleports(context);
    return unrollBuffer(buffer);
}
function renderComponent(comp, props = null, children = null, parentComponent = null) {
    return renderComponentVNode(vue.createVNode(comp, props, children), parentComponent);
}
function renderComponentVNode(vnode, parentComponent = null) {
    const instance = createComponentInstance(vnode, parentComponent, null);
    const res = setupComponent(instance, true /* isSSR */);
    if (shared.isPromise(res)) {
        return res
            .catch(err => {
            vue.warn(`[@vue/server-renderer]: Uncaught error in async setup:\n`, err);
        })
            .then(() => renderComponentSubTree(instance));
    }
    else {
        return renderComponentSubTree(instance);
    }
}
function renderComponentSubTree(instance) {
    const comp = instance.type;
    const { getBuffer, push } = createBuffer();
    if (shared.isFunction(comp)) {
        renderVNode(push, renderComponentRoot(instance), instance);
    }
    else {
        if (!instance.render && !comp.ssrRender && shared.isString(comp.template)) {
            comp.ssrRender = ssrCompile(comp.template, instance);
        }
        if (comp.ssrRender) {
            // optimized
            // set current rendering instance for asset resolution
            setCurrentRenderingInstance(instance);
            comp.ssrRender(instance.proxy, push, instance);
            setCurrentRenderingInstance(null);
        }
        else if (instance.render) {
            renderVNode(push, renderComponentRoot(instance), instance);
        }
        else {
            vue.warn(`Component ${comp.name ? `${comp.name} ` : ``} is missing template or render function.`);
            push(`<!---->`);
        }
    }
    return getBuffer();
}
const compileCache = Object.create(null);
function ssrCompile(template, instance) {
    const cached = compileCache[template];
    if (cached) {
        return cached;
    }
    const { code } = compilerSsr.compile(template, {
        isCustomElement: instance.appContext.config.isCustomElement || shared.NO,
        isNativeTag: instance.appContext.config.isNativeTag || shared.NO,
        onError(err) {
            {
                throw err;
            }
        }
    });
    return (compileCache[template] = Function('require', code)(require));
}
function renderVNode(push, vnode, parentComponent) {
    const { type, shapeFlag, children } = vnode;
    switch (type) {
        case vue.Text:
            push(children);
            break;
        case vue.Comment:
            push(children ? `<!--${children}-->` : `<!---->`);
            break;
        case vue.Fragment:
            push(`<!--[-->`); // open
            renderVNodeChildren(push, children, parentComponent);
            push(`<!--]-->`); // close
            break;
        default:
            if (shapeFlag & 1 /* ELEMENT */) {
                renderElementVNode(push, vnode, parentComponent);
            }
            else if (shapeFlag & 6 /* COMPONENT */) {
                push(renderComponentVNode(vnode, parentComponent));
            }
            else if (shapeFlag & 64 /* TELEPORT */) {
                renderTeleportVNode(push, vnode, parentComponent);
            }
            else if (shapeFlag & 128 /* SUSPENSE */) {
                renderVNode(push, normalizeSuspenseChildren(vnode).content, parentComponent);
            }
            else {
                vue.warn('[@vue/server-renderer] Invalid VNode type:', type, `(${typeof type})`);
            }
    }
}
function renderVNodeChildren(push, children, parentComponent) {
    for (let i = 0; i < children.length; i++) {
        renderVNode(push, normalizeVNode(children[i]), parentComponent);
    }
}
function renderElementVNode(push, vnode, parentComponent) {
    const tag = vnode.type;
    let { props, children, shapeFlag, scopeId, dirs } = vnode;
    let openTag = `<${tag}`;
    if (dirs) {
        props = applySSRDirectives(vnode, props, dirs);
    }
    if (props) {
        openTag += ssrRenderAttrs(props, tag);
    }
    if (scopeId) {
        openTag += ` ${scopeId}`;
        const treeOwnerId = parentComponent && parentComponent.type.__scopeId;
        // vnode's own scopeId and the current rendering component's scopeId is
        // different - this is a slot content node.
        if (treeOwnerId && treeOwnerId !== scopeId) {
            openTag += ` ${treeOwnerId}-s`;
        }
    }
    push(openTag + `>`);
    if (!shared.isVoidTag(tag)) {
        let hasChildrenOverride = false;
        if (props) {
            if (props.innerHTML) {
                hasChildrenOverride = true;
                push(props.innerHTML);
            }
            else if (props.textContent) {
                hasChildrenOverride = true;
                push(shared.escapeHtml(props.textContent));
            }
            else if (tag === 'textarea' && props.value) {
                hasChildrenOverride = true;
                push(shared.escapeHtml(props.value));
            }
        }
        if (!hasChildrenOverride) {
            if (shapeFlag & 8 /* TEXT_CHILDREN */) {
                push(shared.escapeHtml(children));
            }
            else if (shapeFlag & 16 /* ARRAY_CHILDREN */) {
                renderVNodeChildren(push, children, parentComponent);
            }
        }
        push(`</${tag}>`);
    }
}
function applySSRDirectives(vnode, rawProps, dirs) {
    const toMerge = [];
    for (let i = 0; i < dirs.length; i++) {
        const binding = dirs[i];
        const { dir: { getSSRProps } } = binding;
        if (getSSRProps) {
            const props = getSSRProps(binding, vnode);
            if (props)
                toMerge.push(props);
        }
    }
    return vue.mergeProps(rawProps || {}, ...toMerge);
}
function renderTeleportVNode(push, vnode, parentComponent) {
    const target = vnode.props && vnode.props.to;
    const disabled = vnode.props && vnode.props.disabled;
    if (!target) {
        vue.warn(`[@vue/server-renderer] Teleport is missing target prop.`);
        return [];
    }
    if (!shared.isString(target)) {
        vue.warn(`[@vue/server-renderer] Teleport target must be a query selector string.`);
        return [];
    }
    ssrRenderTeleport(push, push => {
        renderVNodeChildren(push, vnode.children, parentComponent);
    }, target, disabled || disabled === '', parentComponent);
}
async function resolveTeleports(context) {
    if (context.__teleportBuffers) {
        context.teleports = context.teleports || {};
        for (const key in context.__teleportBuffers) {
            // note: it's OK to await sequentially here because the Promises were
            // created eagerly in parallel.
            context.teleports[key] = unrollBuffer(await Promise.all(context.__teleportBuffers[key]));
        }
    }
}

function ssrRenderSlot(slots, slotName, slotProps, fallbackRenderFn, push, parentComponent) {
    // template-compiled slots are always rendered as fragments
    push(`<!--[-->`);
    const slotFn = slots[slotName];
    if (slotFn) {
        if (slotFn.length > 1) {
            // only ssr-optimized slot fns accept more than 1 arguments
            const scopeId = parentComponent && parentComponent.type.__scopeId;
            slotFn(slotProps, push, parentComponent, scopeId ? ` ${scopeId}-s` : ``);
        }
        else {
            // normal slot
            renderVNodeChildren(push, slotFn(slotProps), parentComponent);
        }
    }
    else if (fallbackRenderFn) {
        fallbackRenderFn();
    }
    push(`<!--]-->`);
}

function ssrInterpolate(value) {
    return shared.escapeHtml(shared.toDisplayString(value));
}

function ssrRenderList(source, renderItem) {
    if (shared.isArray(source) || shared.isString(source)) {
        for (let i = 0, l = source.length; i < l; i++) {
            renderItem(source[i], i);
        }
    }
    else if (typeof source === 'number') {
        for (let i = 0; i < source; i++) {
            renderItem(i + 1, i);
        }
    }
    else if (shared.isObject(source)) {
        if (source[Symbol.iterator]) {
            const arr = Array.from(source);
            for (let i = 0, l = arr.length; i < l; i++) {
                renderItem(arr[i], i);
            }
        }
        else {
            const keys = Object.keys(source);
            for (let i = 0, l = keys.length; i < l; i++) {
                const key = keys[i];
                renderItem(source[key], key, i);
            }
        }
    }
}

async function ssrRenderSuspense(push, { default: renderContent }) {
    if (renderContent) {
        push(`<!--[-->`);
        renderContent();
        push(`<!--]-->`);
    }
    else {
        push(`<!---->`);
    }
}

const ssrLooseEqual = shared.looseEqual;
function ssrLooseContain(arr, value) {
    return shared.looseIndexOf(arr, value) > -1;
}
// for <input :type="type" v-model="model" value="value">
function ssrRenderDynamicModel(type, model, value) {
    switch (type) {
        case 'radio':
            return shared.looseEqual(model, value) ? ' checked' : '';
        case 'checkbox':
            return (Array.isArray(model)
                ? ssrLooseContain(model, value)
                : model)
                ? ' checked'
                : '';
        default:
            // text types
            return ssrRenderAttr('value', model);
    }
}
// for <input v-bind="obj" v-model="model">
function ssrGetDynamicModelProps(existingProps = {}, model) {
    const { type, value } = existingProps;
    switch (type) {
        case 'radio':
            return shared.looseEqual(model, value) ? { checked: true } : null;
        case 'checkbox':
            return (Array.isArray(model)
                ? ssrLooseContain(model, value)
                : model)
                ? { checked: true }
                : null;
        default:
            // text types
            return { value: model };
    }
}

exports.renderToString = renderToString;
exports.ssrGetDynamicModelProps = ssrGetDynamicModelProps;
exports.ssrInterpolate = ssrInterpolate;
exports.ssrLooseContain = ssrLooseContain;
exports.ssrLooseEqual = ssrLooseEqual;
exports.ssrRenderAttr = ssrRenderAttr;
exports.ssrRenderAttrs = ssrRenderAttrs;
exports.ssrRenderClass = ssrRenderClass;
exports.ssrRenderComponent = renderComponent;
exports.ssrRenderDynamicAttr = ssrRenderDynamicAttr;
exports.ssrRenderDynamicModel = ssrRenderDynamicModel;
exports.ssrRenderList = ssrRenderList;
exports.ssrRenderSlot = ssrRenderSlot;
exports.ssrRenderStyle = ssrRenderStyle;
exports.ssrRenderSuspense = ssrRenderSuspense;
exports.ssrRenderTeleport = ssrRenderTeleport;
