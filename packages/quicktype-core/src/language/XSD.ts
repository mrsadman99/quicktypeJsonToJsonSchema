import { RenderContext, Renderer } from 'Renderer';
import { Option } from 'RendererOptions';
import { TargetLanguage } from '../TargetLanguage';

export class XSDLanguage extends TargetLanguage {
    constructor() {
        super("XSD", ["xsd"], "xsd");
    }

    protected getOptions(): Option<any>[] {
        return [];
    }

    protected makeRenderer(renderContext: RenderContext, optionValues: { [name: string]: any; }): Renderer {
        throw new Error(`Method not implemented. ${renderContext} ${optionValues}`);
    }

    get supportsOptionalClassProperties(): boolean {
        return true;
    }
}