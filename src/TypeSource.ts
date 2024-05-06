import { Readable } from "readable-stream";

import { JSONSourceData } from "quicktype-core";

export interface JSONTypeSource extends JSONSourceData<Readable> {
    kind: "json";
}

export type TypeSource = JSONTypeSource;
