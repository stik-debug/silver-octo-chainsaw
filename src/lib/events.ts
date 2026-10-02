import { EventEmitter } from "events";
// In-process pub/sub for SSE. Single instance only; use Redis pub/sub if you run >1 API instance.
export const bus = new EventEmitter();
bus.setMaxListeners(0);
