export class Decoration {
    constructor(
        public target: any,
        public options: any
    ) { }
}

export const decorateFunction = (target: Function, options: {
    rawArguments: number[]
}) => {
    return new Decoration(target, options)
}

export const decorateTable = (target: object, options: {
    metatable: object
}) => {
    return new Decoration(target, options)
}