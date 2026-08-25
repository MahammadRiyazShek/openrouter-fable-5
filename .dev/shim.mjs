/* A deliberately small DOM good enough to evaluate the module bodies and boot(). */
const listeners = [];
function mkEl(tag = 'div', id = '') {
  const self = {
    tagName: tag.toUpperCase(), id, nodeName: tag.toUpperCase(),
    children: [], dataset: {}, style: {}, value: '', textContent: '',
    innerHTML: '', outerHTML: `<${tag} id="${id}"></${tag}>`, checked: false,
    disabled: false, hidden: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    open: false, files: [], selectedIndex: 0, options: [], href: '', src: '', srcdoc: '',
    classList: { _s: new Set(), add(...c){c.forEach(x=>this._s.add(x));},
      remove(...c){c.forEach(x=>this._s.delete(x));}, toggle(c,f){ f===undefined? (this._s.has(c)?this._s.delete(c):this._s.add(c)) : (f?this._s.add(c):this._s.delete(c)); },
      contains(c){return this._s.has(c);} },
    setAttribute(){}, removeAttribute(){}, getAttribute(){return null;}, hasAttribute(){return false;},
    appendChild(c){ this.children.push(c); return c; }, append(...c){ this.children.push(...c); },
    removeChild(c){ this.children = this.children.filter(x=>x!==c); return c; }, remove(){},
    insertBefore(c){ this.children.unshift(c); return c; },
    addEventListener(t,f){ listeners.push([this,t,f]); }, removeEventListener(){},
    dispatchEvent(){ return true; }, click(){}, focus(){}, blur(){},
    querySelector(){ return null; }, querySelectorAll(){ return []; },
    closest(){ return null; }, contains(){ return false; }, matches(){ return false; },
    getBoundingClientRect(){ return {top:0,left:0,width:800,height:600,bottom:600,right:800}; },
    scrollIntoView(){}, showModal(){ this.open = true; }, close(){ this.open = false; },
    setSelectionRange(){}, select(){}, submit(){}, reset(){},
    insertAdjacentHTML(){}, cloneNode(){ return mkEl(tag, id); },
    replaceChildren(){ this.children = []; },
  };
  return self;
}
const nodes = new Map();
const head = mkEl('head'), body = mkEl('body');
globalThis.document = {
  head, body, documentElement: mkEl('html'), title: '', readyState: 'complete',
  getElementById(id){ if (!nodes.has(id)) nodes.set(id, mkEl('div', id)); return nodes.get(id); },
  createElement(t){ return mkEl(t); },
  createElementNS(_n,t){ return mkEl(t); },
  createDocumentFragment(){ return mkEl('fragment'); },
  createTextNode(t){ const n = mkEl('#text'); n.textContent = t; return n; },
  querySelector(){ return null; }, querySelectorAll(){ return []; },
  addEventListener(t,f){ listeners.push([globalThis.document,t,f]); }, removeEventListener(){},
  execCommand(){ return true; },
};
class Store { constructor(){ this.m = new Map(); }
  getItem(k){ return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k,v){ this.m.set(k, String(v)); }
  removeItem(k){ this.m.delete(k); }
  clear(){ this.m.clear(); }
  key(i){ return [...this.m.keys()][i] ?? null; }
  get length(){ return this.m.size; } }
globalThis.localStorage = new Store();
globalThis.sessionStorage = new Store();
globalThis.matchMedia = (q) => ({ matches:false, media:q, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} });
globalThis.requestAnimationFrame = (f) => setTimeout(() => f(Date.now()), 0);
globalThis.cancelAnimationFrame = (h) => clearTimeout(h);
globalThis.URL.createObjectURL = () => 'blob:stub';
globalThis.URL.revokeObjectURL = () => {};
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} }, userAgent: 'node', language: 'en' }, configurable: true, writable: true });
Object.defineProperty(globalThis, 'location', { value: { href: 'http://localhost/', origin: 'http://localhost', pathname: '/' }, configurable: true, writable: true });
globalThis.window = globalThis;
globalThis.addEventListener = (t,f) => listeners.push([globalThis,t,f]);
globalThis.removeEventListener = () => {};
globalThis.alert = () => {}; globalThis.confirm = () => true; globalThis.prompt = () => null;
globalThis.AbortController = globalThis.AbortController || class { constructor(){ this.signal={}; } abort(){} };
globalThis.fetch = async () => { throw new Error('offline-stub'); };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.__listeners = listeners;
