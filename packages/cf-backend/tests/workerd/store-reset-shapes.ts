/** The history seed a refused workspace answered: its status and body text. */
export interface SeedAnswer {
  readonly status: number;
  readonly body: string;
}

/** The chat frames a refused workspace sent: on connect, and in answer to a sent message, as JSON text. */
export interface ChatAnswers {
  readonly connected: string;
  readonly answered: string;
}
