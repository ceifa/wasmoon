export default class MultiReturn extends Array {
    public static from(arr: any[]): MultiReturn {
        const mt = new MultiReturn(arr.length)
        mt.push(...arr)
        return mt
    }
}
