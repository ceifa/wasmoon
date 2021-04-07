export interface BaseDecorationOptions {
    metatable?: Record<any, any>
}

export class Decoration<T = any, K extends BaseDecorationOptions = BaseDecorationOptions> {
    public constructor(public target: T, public options: K) {}
}

export function decorate(target: any, options: BaseDecorationOptions): Decoration<any, BaseDecorationOptions> {
    return new Decoration<any, BaseDecorationOptions>(target, options)
}
