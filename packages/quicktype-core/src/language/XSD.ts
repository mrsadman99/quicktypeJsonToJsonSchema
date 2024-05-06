import { RenderContext, Renderer } from 'Renderer';
import { Option } from 'RendererOptions';
import { TargetLanguage } from '../TargetLanguage';

export class XSDLanguage extends TargetLanguage {
    constructor() {
        super("XSD", ["xsd"], "xsd");
    }

    protected getOptions(): Option<any>[] {
        throw new Error('Method not implemented.');
    }

    protected makeRenderer(renderContext: RenderContext, optionValues: { [name: string]: any; }): Renderer {
        throw new Error('Method not implemented.');
    }
}