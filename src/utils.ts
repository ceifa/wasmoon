export const isPromise = (target: any): target is Promise<unknown> => {
    return target && (Promise.resolve(target) === target || typeof target.then === 'function')
}
