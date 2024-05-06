import { StringMap } from "./support/Support";

export type ErrorProperties =
    | { kind: "InternalError"; properties: { message: string } }

    // Misc
    | {
        kind: "MiscJSONParseError";
        properties: { description: string; address: string; message: string };
    }
    | { kind: "MiscReadError"; properties: { fileOrURL: string; message: string } }
    | { kind: "MiscUnicodeHighSurrogateWithoutLowSurrogate"; properties: {} }
    | { kind: "MiscInvalidMinMaxConstraint"; properties: { min: number; max: number } }

    // Inference
    | { kind: "InferenceJSONReferenceNotRooted"; properties: { reference: string } }
    | { kind: "InferenceJSONReferenceToUnion"; properties: { reference: string } }
    | { kind: "InferenceJSONReferenceWrongProperty"; properties: { reference: string } }
    | { kind: "InferenceJSONReferenceInvalidArrayIndex"; properties: { reference: string } }

    // Driver
    | { kind: "DriverUnknownSourceLanguage"; properties: { lang: string } }
    | { kind: "DriverUnknownOutputLanguage"; properties: { lang: string } }
    | { kind: "DriverMoreThanOneInputGiven"; properties: { topLevel: string } }
    | { kind: "DriverCannotInferNameForSchema"; properties: { uri: string } }
    | { kind: "DriverNoGraphQLQueryGiven"; properties: {} }
    | { kind: "DriverNoGraphQLSchemaInDir"; properties: { dir: string } }
    | { kind: "DriverMoreThanOneGraphQLSchemaInDir"; properties: { dir: string } }
    | { kind: "DriverSourceLangMustBeGraphQL"; properties: {} }
    | { kind: "DriverGraphQLSchemaNeeded"; properties: {} }
    | { kind: "DriverInputFileDoesNotExist"; properties: { filename: string } }
    | { kind: "DriverCannotMixJSONWithOtherSamples"; properties: { dir: string } }
    | { kind: "DriverCannotMixNonJSONInputs"; properties: { dir: string } }
    | { kind: "DriverUnknownDebugOption"; properties: { option: string } }
    | { kind: "DriverNoLanguageOrExtension"; properties: {} }
    | { kind: "DriverCLIOptionParsingFailed"; properties: { message: string } }

    // IR
    | { kind: "IRNoForwardDeclarableTypeInCycle"; properties: {} }
    | { kind: "IRTypeAttributesNotPropagated"; properties: { count: number; indexes: number[] } }
    | { kind: "IRNoEmptyUnions"; properties: {} }

    // Rendering
    | { kind: "RendererUnknownOptionValue"; properties: { value: string; name: string } }

    // TypeScript input
    | { kind: "TypeScriptCompilerError"; properties: { message: string } };

export type ErrorKinds = ErrorProperties extends { kind: infer K } ? K : never;

type ErrorMessages = { readonly [K in ErrorKinds]: string };

const errorMessages: ErrorMessages = {
    InternalError: "Internal error: ${message}",

    // Misc
    MiscJSONParseError: "Syntax error in ${description} JSON ${address}: ${message}",
    MiscReadError: "Cannot read from file or URL ${fileOrURL}: ${message}",
    MiscUnicodeHighSurrogateWithoutLowSurrogate: "Malformed unicode: High surrogate not followed by low surrogate",
    MiscInvalidMinMaxConstraint: "Invalid min-max constraint: ${min}-${max}",

    // Inference
    InferenceJSONReferenceNotRooted: "JSON reference doesn't start with '#/': ${reference}",
    InferenceJSONReferenceToUnion: "JSON reference points to a union type: ${reference}",
    InferenceJSONReferenceWrongProperty: "JSON reference points to a non-existant property: ${reference}",
    InferenceJSONReferenceInvalidArrayIndex: "JSON reference uses invalid array index: ${reference}",

    // Driver
    DriverUnknownSourceLanguage: "Unknown source language ${lang}",
    DriverUnknownOutputLanguage: "Unknown output language ${lang}",
    DriverMoreThanOneInputGiven: "More than one input given for top-level ${topLevel}",
    DriverCannotInferNameForSchema: "Cannot infer name for schema ${uri}",
    DriverNoGraphQLQueryGiven: "Please specify at least one GraphQL query as input",
    DriverNoGraphQLSchemaInDir: "No GraphQL schema in ${dir}",
    DriverMoreThanOneGraphQLSchemaInDir: "More than one GraphQL schema in ${dir}",
    DriverSourceLangMustBeGraphQL: "If a GraphQL schema is specified, the source language must be GraphQL",
    DriverGraphQLSchemaNeeded: "Please specify a GraphQL schema with --graphql-schema or --graphql-introspect",
    DriverInputFileDoesNotExist: "Input file ${filename} does not exist",
    DriverCannotMixJSONWithOtherSamples:
        "Cannot mix JSON samples with JSON Schems, GraphQL, or TypeScript in input subdirectory ${dir}",
    DriverCannotMixNonJSONInputs: "Cannot mix JSON Schema, GraphQL, and TypeScript in an input subdirectory ${dir}",
    DriverUnknownDebugOption: "Unknown debug option ${option}",
    DriverNoLanguageOrExtension: "Please specify a language (--lang) or an output file extension",
    DriverCLIOptionParsingFailed: "Option parsing failed: ${message}",

    // IR
    IRNoForwardDeclarableTypeInCycle:
        "Cannot resolve cycle because it doesn't contain types that can be forward declared",
    IRTypeAttributesNotPropagated:
        "Type attributes for ${count} types were not carried over to the new graph: ${indexes}",
    IRNoEmptyUnions: "Trying to make an empty union - do you have an impossible type in your schema?",

    // Rendering
    RendererUnknownOptionValue: "Unknown value ${value} for option ${name}",

    // TypeScript input
    TypeScriptCompilerError: "TypeScript error: ${message}"
};

export type ErrorPropertiesForName<K> = Extract<ErrorProperties, { kind: K }> extends { properties: infer P }
    ? P
    : never;

export class QuickTypeError extends Error {
    constructor(
        readonly errorMessage: string,
        readonly messageName: string,
        userMessage: string,
        readonly properties: StringMap
    ) {
        super(userMessage);
    }
}

export function messageError<N extends ErrorKinds>(kind: N, properties: ErrorPropertiesForName<N>): never {
    const message = errorMessages[kind];
    let userMessage: string = message;
    const propertiesMap = properties as StringMap;

    for (const name of Object.getOwnPropertyNames(propertiesMap)) {
        let value = propertiesMap[name];
        if (typeof value === "object" && typeof value.toString === "function") {
            value = value.toString();
        } else if (typeof value.message === "string") {
            value = value.message;
        } else if (typeof value !== "string") {
            value = JSON.stringify(value);
        }
        userMessage = userMessage.replace("${" + name + "}", value);
    }

    throw new QuickTypeError(message, kind, userMessage, propertiesMap);
}

export function messageAssert<N extends ErrorKinds>(
    assertion: boolean,
    kind: N,
    properties: ErrorPropertiesForName<N>
): void {
    if (assertion) return;
    return messageError(kind, properties);
}
