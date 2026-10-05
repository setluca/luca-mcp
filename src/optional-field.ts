import * as Option from "effect/Option";
import * as R from "effect/Record";

/**
 * Spreads a single optional field into an object literal, or nothing when the
 * value is absent.
 *
 * The package compiles under `exactOptionalPropertyTypes`, so an optional
 * property that is not set has to be *missing* from the object rather than
 * present with the value `undefined`. Writing that as a spread keeps the
 * absence decision in one place instead of repeating a conditional at every
 * construction site.
 */
export function optionalField<K extends string, V>(
  key: K,
  value: V | undefined | null
): Partial<Record<K, V>>;
export function optionalField<V>(key: string, value: V | undefined | null) {
  return Option.fromNullishOr(value).pipe(
    Option.match({
      // Returning `undefined` here instead of `{}` is indistinguishable at
      // every call site: the result is only ever spread, and spreading either
      // value contributes no keys. The empty object is written out because it
      // matches the declared return type.
      // Stryker disable next-line ArrowFunction: `...undefined` and `...{}` both contribute nothing
      onNone: () => ({}),
      onSome: (present) => R.fromEntries([[key, present]]),
    })
  );
}

/**
 * Spreads the fields `build` makes from a value, or nothing when the value is
 * absent. {@link optionalField} covers the single-key case.
 */
export function optionalFields<V, F extends object>(
  value: V | undefined | null,
  build: (present: V) => F
): Partial<F> {
  return Option.fromNullishOr(value).pipe(
    Option.match({ onNone: () => ({}), onSome: build })
  );
}

/** Spreads `fields` when `include` holds, or nothing when it does not. */
export function fieldsWhen<F extends object>(
  include: boolean,
  fields: F
): Partial<F> {
  return include ? fields : {};
}
