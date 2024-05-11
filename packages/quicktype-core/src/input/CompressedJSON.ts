import { addHashCode, hashCodeInit, hashString } from "collection-utils";

import { defined, panic, assert } from "../support/Support";
import { TransformedStringTypeKind, isPrimitiveStringTypeKind } from "../Type";
import { DateTimeRecognizer } from "../DateTime";
import { inferTransformedStringTypeKindForString } from "../attributes/StringTypes";

export enum Tag {
    Null,
    Integer,
    Double,
    InternedString,
    Object,
    Array,
    StringFormat,
    Boolean
}

export type Value = number;

const TAG_BITS = 4;
const TAG_MASK = (1 << TAG_BITS) - 1;

export function makeValue(t: Tag, index: number): Value {
    return t | (index << TAG_BITS);
}

function getIndex(v: Value, tag: Tag): number {
    assert(valueTag(v) === tag, "Trying to get index for value with invalid tag");
    return v >> TAG_BITS;
}

export function valueTag(v: Value): Tag {
    return v & TAG_MASK;
}

type Context = {
    currentObject: Value[] | undefined;
    currentArray: Value[] | undefined;
    currentKey: string | undefined;
    currentNumberChunk: string | undefined;
    currentUncompressedObject: object[] | object | undefined;
};

export abstract class CompressedJSON<T> {
    private _rootValue: Value | undefined;

    private _ctx: Context | undefined;
    private _contextStack: Context[] = [];

    private _strings: string[] = [];
    private _stringIndexes: { [str: string]: number } = {};
    private _objects: Value[][] = [];
    private _arrays: Value[][] = [];

    protected _uncompressedSource: object = {};

    constructor(readonly dateTimeRecognizer: DateTimeRecognizer, readonly handleRefs: boolean) { }

    abstract parse(input: T): Promise<Value>;

    getUncompressedObject(): object {
        return this._uncompressedSource;
    }

    parseSync(_input: T): Value {
        return panic("parseSync not implemented in CompressedJSON");
    }

    getStringForValue(v: Value): string {
        const tag = valueTag(v);
        assert(tag === Tag.InternedString);
        return this._strings[getIndex(v, tag)];
    }

    getObjectForValue = (v: Value): Value[] => {
        return this._objects[getIndex(v, Tag.Object)];
    };

    getArrayForValue = (v: Value): Value[] => {
        return this._arrays[getIndex(v, Tag.Array)];
    };

    getStringFormatTypeKind(v: Value): TransformedStringTypeKind {
        const kind = this._strings[getIndex(v, Tag.StringFormat)];
        if (!isPrimitiveStringTypeKind(kind) || kind === "string") {
            return panic("Not a transformed string type kind");
        }
        return kind;
    }

    protected get context(): Context {
        return defined(this._ctx);
    }

    protected internString(s: string): number {
        if (Object.prototype.hasOwnProperty.call(this._stringIndexes, s)) {
            return this._stringIndexes[s];
        }
        const index = this._strings.length;
        this._strings.push(s);
        this._stringIndexes[s] = index;
        return index;
    }

    protected makeString(s: string): Value {
        const value = makeValue(Tag.InternedString, this.internString(s));
        assert(typeof value === "number", `Interned string value is not a number: ${value}`);
        return value;
    }

    protected internObject(obj: Value[]): Value {
        const index = this._objects.length;
        this._objects.push(obj);
        return makeValue(Tag.Object, index);
    }

    protected internArray = (arr: Value[]): Value => {
        const index = this._arrays.length;
        this._arrays.push(arr);
        return makeValue(Tag.Array, index);
    };

    protected get isExpectingRef(): boolean {
        return this._ctx !== undefined && this._ctx.currentKey === "$ref";
    }

    protected commitValue(value: Value): void {
        assert(typeof value === "number", `CompressedJSON value is not a number: ${value}`);
        if (this._ctx === undefined) {
            assert(
                this._rootValue === undefined,
                "Committing value but nowhere to commit to - root value still there."
            );
            this._rootValue = value;
        } else if (this._ctx.currentObject !== undefined) {
            if (this._ctx.currentKey === undefined) {
                return panic("Must have key and can't have string when committing");
            }
            this._ctx.currentObject.push(this.makeString(this._ctx.currentKey), value);
            this._ctx.currentKey = undefined;
        } else if (this._ctx.currentArray !== undefined) {
            this._ctx.currentArray.push(value);
        } else {
            return panic("Committing value but nowhere to commit to");
        }
    }

    protected commitNull(): void {
        this.setUncompressedObjectSimpleProperty(null);
        this.commitValue(makeValue(Tag.Null, 0));
    }

    protected commitBoolean(value: boolean): void {
        this.setUncompressedObjectSimpleProperty(value);
        this.commitValue(makeValue(Tag.Boolean, 0));
    }

    protected commitNumber(value: number): void {
        this.setUncompressedObjectSimpleProperty(value);

        const isIntegerLimitExceeded =
            value !== Math.floor(value) || value < Number.MIN_SAFE_INTEGER || value > Number.MAX_SAFE_INTEGER;
        const numberTag = isIntegerLimitExceeded || value % 1 ? Tag.Double : Tag.Integer;
        this.commitValue(makeValue(numberTag, 0));
    }

    protected commitString(s: string): void {
        this.setUncompressedObjectSimpleProperty(s);

        let value: Value | undefined = undefined;
        if (this.handleRefs && this.isExpectingRef) {
            value = this.makeString(s);
        } else {
            const format = inferTransformedStringTypeKindForString(s, this.dateTimeRecognizer);
            if (format !== undefined) {
                value = makeValue(Tag.StringFormat, this.internString(format));
            } else {
                value = this.makeString(s);
            }
        }
        this.commitValue(value);
    }

    protected finish(): Value {
        const value = this._rootValue;
        if (value === undefined) {
            return panic("Finished without root document");
        }
        assert(this._ctx === undefined && this._contextStack.length === 0, "Finished with contexts present");
        this._rootValue = undefined;
        return value;
    }

    protected pushContext(): void {
        if (this._ctx !== undefined) {
            this._contextStack.push(this._ctx);
        }
        this._ctx = {
            currentObject: undefined,
            currentArray: undefined,
            currentKey: undefined,
            currentNumberChunk: undefined,
            currentUncompressedObject: undefined
        };
    }

    private setUncompressedObjectSimpleProperty(currentUncompressedData: any): any {
        return this.setUncompressedObjectProperty(currentUncompressedData, this._ctx?.currentUncompressedObject, this._ctx?.currentKey);
    }

    private setUncompressedObjectProperty(
        currentUncompressedObject: any,
        parentStructure: object | object[] | undefined,
        objectKey: string | undefined
    ): any {
        if (parentStructure === undefined && typeof currentUncompressedObject === 'object') {
            this._uncompressedSource = currentUncompressedObject;
        } else if (Array.isArray(parentStructure)) {
            parentStructure.push(currentUncompressedObject)
        } else if (typeof parentStructure === 'object' && objectKey) {
            Object.assign(parentStructure, { [objectKey]: currentUncompressedObject });
        }
        return currentUncompressedObject;
    }

    protected pushObjectContext(): void {
        const parentStructure = this._ctx?.currentUncompressedObject;
        const objectKey = this._ctx?.currentKey;

        this.pushContext();
        const currentCtx = defined(this._ctx);
        currentCtx.currentObject = [];
        currentCtx.currentUncompressedObject = this.setUncompressedObjectProperty({}, parentStructure, objectKey);
    }

    protected setPropertyKey(key: string): void {
        const ctx = this.context;
        ctx.currentKey = key;
    }

    protected finishObject(): void {
        const obj = this.context.currentObject;
        if (obj === undefined) {
            return panic("Object ended but not started");
        }
        this.popContext();
        this.commitValue(this.internObject(obj));
    }

    protected pushArrayContext(): void {
        const parentStructure = this._ctx?.currentUncompressedObject;
        const arrayKey = this._ctx?.currentKey;

        this.pushContext();
        const currentCtx = defined(this._ctx);
        currentCtx.currentArray = [];
        currentCtx.currentUncompressedObject = this.setUncompressedObjectProperty([], parentStructure, arrayKey);
    }

    protected finishArray(): void {
        const arr = this.context.currentArray;
        if (arr === undefined) {
            return panic("Array ended but not started");
        }
        this.popContext();
        this.commitValue(this.internArray(arr));
    }

    protected popContext(): void {
        assert(this._ctx !== undefined, "Popping context when there isn't one");
        this._ctx = this._contextStack.pop();
    }

    equals(other: any): boolean {
        return this === other;
    }

    hashCode(): number {
        let hashAccumulator = hashCodeInit;
        for (const s of this._strings) {
            hashAccumulator = addHashCode(hashAccumulator, hashString(s));
        }

        for (const s of Object.getOwnPropertyNames(this._stringIndexes).sort()) {
            hashAccumulator = addHashCode(hashAccumulator, hashString(s));
            hashAccumulator = addHashCode(hashAccumulator, this._stringIndexes[s]);
        }

        for (const o of this._objects) {
            for (const v of o) {
                hashAccumulator = addHashCode(hashAccumulator, v);
            }
        }
        for (const o of this._arrays) {
            for (const v of o) {
                hashAccumulator = addHashCode(hashAccumulator, v);
            }
        }

        return hashAccumulator;
    }
}

export class CompressedJSONFromString extends CompressedJSON<string> {
    protected makeUncompressedSource(input: string): object {
        this._uncompressedSource = JSON.parse(input);
        return this._uncompressedSource;
    }

    async parse(input: string): Promise<Value> {
        return this.parseSync(input);
    }

    parseSync(input: string): Value {
        const json = this.makeUncompressedSource(input);
        this.process(json);
        return this.finish();
    }

    private process(json: unknown): void {
        if (json === null) {
            this.commitNull();
        } else if (typeof json === "boolean") {
            this.commitBoolean(json);
        } else if (typeof json === "string") {
            this.commitString(json);
        } else if (typeof json === "number") {
            this.commitNumber(json);
        } else if (Array.isArray(json)) {
            this.pushArrayContext();
            for (const v of json) {
                this.process(v);
            }
            this.finishArray();
        } else if (typeof json === "object") {
            this.pushObjectContext();
            for (const key of Object.getOwnPropertyNames(json)) {
                this.setPropertyKey(key);
                this.process((json as any)[key]);
            }
            this.finishObject();
        } else {
            return panic("Invalid JSON object");
        }
    }
}
