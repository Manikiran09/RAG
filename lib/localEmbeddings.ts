import { Embeddings } from "@langchain/core/embeddings";

export class LocalHashEmbeddings extends Embeddings {
  private readonly dimensions = 384;

  constructor() {
    super({});
  }

  private embed(text: string): number[] {
    const vector = new Array(this.dimensions).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9#@]+/g) ?? [];

    for (const token of tokens) {
      let hash = 2166136261;
      for (const char of token) {
        hash ^= char.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 16777619);
      }
      const index = Math.abs(hash) % this.dimensions;
      const sign = hash % 2 === 0 ? -1 : 1;
      vector[index] += sign * (1 + Math.min(token.length, 12) / 12);
    }

    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    return vector.map((value) => value / norm);
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embed(text));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text);
  }
}
