import { GeminiService, LlmUnavailableError } from '../llm/gemini.service.js';
import { WaybillValidator } from './waybill-validator.service.js';

const INPUT = {
  file: Buffer.from('%PDF-1.7'),
  mimeType: 'application/pdf' as const,
  details: null,
  escrowCreatedAt: 1_700_000_000,
};

function validatorWith(generate: () => Promise<unknown>, available = true) {
  return new WaybillValidator({
    available,
    generate,
  } as unknown as GeminiService);
}

describe('WaybillValidator', () => {
  it('sends the file with the schema and returns the verdict', async () => {
    const verdict = { verdict: 'valid', reasons: ['OK'] };
    const generate = vi.fn(async () => verdict);
    expect(await validatorWith(generate).validate(INPUT)).toEqual(verdict);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [{ mimeType: 'application/pdf', data: INPUT.file }],
        jsonSchema: expect.any(Object),
      }),
    );
  });

  it('turns provider failures into an explained unavailable verdict', async () => {
    const error = new LlmUnavailableError(
      'ApiError: {"error":{"code":503,"message":"This model is currently experiencing high demand."}}',
    );
    const result = await validatorWith(async () => {
      throw error;
    }).validate(INPUT);
    expect(result).toEqual({
      verdict: 'unavailable',
      reasons: [
        'Walidacja niedostępna: błąd modelu (HTTP 503: This model is currently experiencing high demand.).',
      ],
    });
  });

  it('does not call the model without an API key', async () => {
    const generate = vi.fn();
    const result = await validatorWith(generate, false).validate(INPUT);
    expect(result.verdict).toBe('unavailable');
    expect(generate).not.toHaveBeenCalled();
  });
});
