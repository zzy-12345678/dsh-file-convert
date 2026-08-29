// pdfjs-dist expects browser globals (DOMMatrix, Path2D, ImageData) that Node
// does not provide. @napi-rs/canvas ships compatible implementations.
// IMPORTANT: import this module before any pdfjs-dist import.
import { DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas'

const globals = globalThis as unknown as Record<string, unknown>
globals.DOMMatrix ??= DOMMatrix
globals.Path2D ??= Path2D
globals.ImageData ??= ImageData
