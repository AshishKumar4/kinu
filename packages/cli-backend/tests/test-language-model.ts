import type { LanguageModelV2 } from '@ai-sdk/provider';

type TestLanguageModelOptions = {
  provider?: string;
  modelId?: string;
  supportedUrls?: LanguageModelV2['supportedUrls'];
  doGenerate?: LanguageModelV2['doGenerate'];
  doStream?: LanguageModelV2['doStream'];
};

export class TestLanguageModelV2 implements LanguageModelV2 {
  readonly specificationVersion = 'v2';
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: LanguageModelV2['supportedUrls'];
  doGenerate: LanguageModelV2['doGenerate'];
  doStream: LanguageModelV2['doStream'];

  constructor({
    provider = 'test',
    modelId = 'test-model',
    supportedUrls = {},
    doGenerate = async () => { throw new Error('Test model does not implement doGenerate'); },
    doStream = async () => { throw new Error('Test model does not implement doStream'); },
  }: TestLanguageModelOptions = {}) {
    this.provider = provider;
    this.modelId = modelId;
    this.supportedUrls = supportedUrls;
    this.doGenerate = doGenerate;
    this.doStream = doStream;
  }
}
