/**
 * Loader for optional native dependencies.
 *
 * The transports and the image pipeline each need a native package that most
 * consumers will not have installed. Importing through a non-literal
 * specifier keeps TypeScript from trying to resolve the module at build time,
 * so the library compiles and ships without them and only fails at the point
 * of use, with an actionable message.
 */

import { MissingDependencyError } from './errors.js';

/**
 * Imports a package by name at runtime.
 *
 * @param name    package specifier, for example `usb`
 * @param purpose short description used in the error message
 */
export async function importOptional<T = unknown>(name: string, purpose: string): Promise<T> {
  // Held in a variable so the specifier is not statically analysable.
  const specifier: string = name;
  try {
    const loaded = (await import(specifier)) as T & { default?: T };
    // Native packages are usually CommonJS, so unwrap the interop default.
    return (loaded.default ?? loaded) as T;
  } catch (error) {
    throw new MissingDependencyError(name, purpose, { cause: error });
  }
}
