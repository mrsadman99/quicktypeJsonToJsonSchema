import { Readable } from "readable-stream";

import { JSONSourceData } from "quicktype-core";

export interface JSONTypeSource extends JSONSourceData<Readable> {
    kind: "json";
}

export interface XMLWithXSDTypeSource extends JSONSourceData<Readable> {
    kind: "XMLWithXSD"
}

export type TypeSource = JSONTypeSource | XMLWithXSDTypeSource;
