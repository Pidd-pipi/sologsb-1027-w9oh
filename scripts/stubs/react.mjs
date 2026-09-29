export default {};
export const Fragment = Symbol('Fragment');
const noop = () => {};
export const useEffect = noop;
export const useMemo = (factory) => factory();
export const useReducer = () => [{}, noop];
export const useRef = () => ({});
export const useState = (initial) => [initial, noop];
