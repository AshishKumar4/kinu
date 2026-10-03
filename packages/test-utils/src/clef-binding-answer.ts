/**
 * What `env.AI.run('@cf/cloudflare/clef', body)` answered on a throwaway Worker on this account, 2026-10-02T21:14:50Z
 * (kinu-logs/evals-fast/clef-satisfaction/binding-2026-10-02/response.json): bare, with its usage. The REST endpoint
 * wraps the same object in `result`.
 */
export const CLEF_BINDING_ANSWER = {
  "model": "clef",
  "answers": {
    "satisfaction": {
      "type": "score",
      "score": 0.5407,
      "legend": {
        "0": "Very dissatisfied",
        "1": "Dissatisfied",
        "2": "Neutral",
        "3": "Satisfied",
        "4": "Very satisfied"
      },
      "probabilities": {
        "0": 0.5216,
        "1": 0.4402,
        "2": 0.0211,
        "3": 0.0102,
        "4": 0.0069
      },
      "confidence": 0.333
    },
    "corrected": {
      "type": "noul",
      "noul": 0.9722
    },
    "wrong": {
      "type": "choice",
      "choice": "misunderstood",
      "probabilities": {
        "nothing": 0.0752,
        "misunderstood": 0.9248
      },
      "confidence": 0.7218
    }
  },
  "usage": {
    "input_tokens": 406,
    "output_tokens": 0
  }
} as const;
