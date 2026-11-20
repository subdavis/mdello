import { type SearchDoc, SearchIndex, type SearchOptions, type SearchResponse } from './engine';

export type WorkerRequest =
  | { type: 'update'; upsert: SearchDoc[]; remove: string[] }
  | { type: 'search'; requestId: number; query: string; options: SearchOptions };

export interface WorkerResponse {
  requestId: number;
  response: SearchResponse;
}

const index = new SearchIndex();

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === 'update') {
    index.remove(message.remove);
    index.upsert(message.upsert);
    return;
  }
  const reply: WorkerResponse = {
    requestId: message.requestId,
    response: index.search(message.query, message.options),
  };
  self.postMessage(reply);
};
