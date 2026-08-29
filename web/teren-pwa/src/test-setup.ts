/**
 * Test bootstrap.
 *
 * `fake-indexeddb/auto` installs a real, in-memory IndexedDB over the jsdom globals, so the Dexie
 * specs exercise the actual database — transactions, indexes, blob round-trips — instead of a
 * hand-written stub that would agree with whatever the code happens to do.
 */
import 'fake-indexeddb/auto';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';

if (typeof globalThis.structuredClone !== 'function') {
  throw new Error('structuredClone is required by fake-indexeddb; run tests on Node 18 or newer');
}

/**
 * IndexedDB stores values by structured clone, and jsdom's `Blob`/`File` are not cloneable by
 * Node's `structuredClone` — they come back as `{}`, which would quietly turn "the store keeps
 * real blobs" into an untestable claim. Node's own implementations clone correctly and behave the
 * same for everything these specs do, so the platform classes win here.
 */
Object.defineProperty(globalThis, 'Blob', { value: NodeBlob, writable: true, configurable: true });
Object.defineProperty(globalThis, 'File', { value: NodeFile, writable: true, configurable: true });
