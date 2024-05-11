import { Readable } from "readable-stream";
import { CompressedJSON, Value, defined } from "quicktype-core";
import { Parser } from "stream-json";

const methodMap: { [name: string]: string } = {
    startObject: "pushObjectContext",
    endObject: "finishObject",
    startArray: "pushArrayContext",
    endArray: "finishArray",
    startNumber: "handleStartNumber",
    numberChunk: "handleNumberChunk",
    endNumber: "handleEndNumber",
    keyValue: "setPropertyKey",
    stringValue: "commitString",
    nullValue: "commitNull",
    trueValue: "handleBooleanValue",
    falseValue: "handleBooleanValue"
};

export class CompressedJSONFromStream extends CompressedJSON<Readable> {
    async parse(readStream: Readable): Promise<Value> {
        const combo = new Parser({ packKeys: true, packStrings: true });
        combo.on("data", (item: { name: string; value: string | undefined }) => {
            if (typeof methodMap[item.name] === "string") {
                (this as any)[methodMap[item.name]](item.value);
            }
        });
        const promise = new Promise<Value>((resolve, reject) => {
            combo.on("end", () => {
                resolve(this.finish());
            });
            combo.on("error", (err: any) => {
                reject(err);
            });
        });
        readStream.setEncoding("utf8");
        readStream.pipe(combo);
        readStream.resume();
        return promise;
    }

    protected handleStartNumber = (): void => {
        this.context.currentNumberChunk = '';
    };

    protected handleNumberChunk = (s: string): void => {
        const ctx = this.context;

        ctx.currentNumberChunk += s;
    };

    protected handleEndNumber(): void {
        const numberChunk = defined(this.context.currentNumberChunk);
        const value = +numberChunk;
        this.context.currentNumberChunk = undefined;

        this.commitNumber(value);
    }

    protected handleBooleanValue(value: boolean): void {
        this.commitBoolean(value);
    }
}
