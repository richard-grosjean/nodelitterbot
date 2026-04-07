import { EventEmitter } from "node:events";

export const EVENT_UPDATE = "update";

type UnsubscribeFn = () => void;

export class LitterRobotEvent {
  private readonly _emitter = new EventEmitter();

  on(eventName: string, callback: (...args: unknown[]) => void): UnsubscribeFn {
    this._emitter.on(eventName, callback);
    return () => {
      this._emitter.off(eventName, callback);
    };
  }

  emit(eventName: string, ...args: unknown[]): void {
    this._emitter.emit(eventName, ...args);
  }
}
