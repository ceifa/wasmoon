export interface BaseDecorationOptions {
    metatable?: Record<any, any>
}

export class Decoration<T = any, K extends BaseDecorationOptions = BaseDecorationOptions> {
    public constructor(
        public target: T,
        public options: K,
    ) {}
}

export function decorate<T extends BaseDecorationOptions = BaseDecorationOptions>(target: unknown, options: T): Decoration<any, T> {
    return new Decoration<any, T>(target, options)
}
