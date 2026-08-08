import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * The prototype's only enforced rule was "max 300 lines per file". It had ten
 * violations, had never been green, and would not have caught a single one of
 * the bugs that actually shipped. `max-lines` is deliberately absent here.
 *
 * Every project-specific rule below maps to a defect found in that codebase.
 * The comment names it.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'ephem/**', 'coverage/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ~110 console.* calls across 23 files, no levels, no redaction —
      // including user-entered location data written to stdout on every
      // request (routes/geocoding.js:163-172).
      'no-console': 'error',

      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length>1]",
          message:
            'new Date(y, m, d) uses the SERVER timezone. Transit dates built this way ' +
            'were compared against UTC ephemeris data (transit-calculator.js:36-42, ' +
            'activations.js:82,109,152), silently shifting results by a day at ' +
            'boundaries. Use Date.UTC or Temporal.',
        },
        {
          selector: "BinaryExpression[operator='%'][right.value=360]",
          message:
            'Use wrap360() from src/math/angle.ts. Four hand-written copies of this ' +
            'maths existed in the prototype, and degreesToSign (positions.js:9) never ' +
            'normalised, yielding SIGNS[12] === undefined.',
        },
      ],

      // Flags dead checks like `if (!natalPos)` on a number, which rejected a
      // natal body at exactly 0°00' Aries (activations.js:468-479).
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],

      complexity: ['error', 12],
      'max-depth': ['error', 4],
      'max-params': ['error', 4],
      // Deliberately NOT max-lines. File length is a proxy metric;
      // full-transit-calculator.js was not bad because it was 518 lines, it was
      // bad because it ran a ternary search where a root-find belongs.
    },
  },

  {
    // Only the adapter may talk to the binding. This is what makes the
    // speedLongitude / longitudeSpeed / speed three-way confusion structurally
    // unrepeatable rather than merely fixed.
    files: ['src/**/*.ts'],
    ignores: ['src/ephemeris/swe.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'sweph',
              message: 'Import from src/ephemeris/swe.ts. It is the only door to the binding.',
            },
          ],
        },
      ],
    },
  },

  {
    // Config is parsed and frozen once, before the server binds, so a bad
    // deploy fails at startup rather than at the first request.
    files: ['src/**/*.ts'],
    ignores: ['src/config/env.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Import from src/config/env.ts.',
        },
      ],
    },
  },

  {
    files: ['scripts/**/*.ts', 'scripts/**/*.mjs'],
    rules: {
      // Scripts are CLIs; stdout is their interface.
      'no-console': 'off',
      'no-restricted-properties': 'off',
    },
  },

  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-console': 'off',
      'no-restricted-properties': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // expect.extend's custom matchers are declared via module augmentation,
      // which the type-aware rules cannot follow into a setup file.
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },

  {
    files: ['**/*.mjs', '**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      // Return types are a TypeScript concern; plain .mjs scripts have none.
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },

  {
    // Config files sit outside the tsconfig project graph.
    files: ['*.config.ts', '*.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },

  prettier,
);
