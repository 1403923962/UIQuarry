// Runs at document_start in the main world of explicitly enabled sites.
(() => {
  const marker = Symbol.for("uiquarry.webgl-preserve");
  for (const prototype of [globalThis.HTMLCanvasElement?.prototype, globalThis.OffscreenCanvas?.prototype]) {
    if (!prototype) continue;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "getContext");
    const native = descriptor?.value;
    if (typeof native !== "function" || native[marker] || (!descriptor.configurable && !descriptor.writable)) continue;
    function getContext(type, ...rest) {
      if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") {
        const options = rest[0];
        if (options == null || typeof options === "object" || typeof options === "function") {
          // WebIDL reads dictionary members by name, including inherited properties.
          // Forward the getter with its original receiver; never mutate the site's options.
          rest[0] = new Proxy(Object.create(null), {
            get(_, name) {
              return name === "preserveDrawingBuffer" ? true : options?.[name];
            }
          });
        }
      }
      return Reflect.apply(native, this, arguments.length === 0 ? [] : [type, ...rest]);
    }
    Object.defineProperty(getContext, marker, { value: true });
    Object.defineProperty(prototype, "getContext", { ...descriptor, value: getContext });
  }
})();
