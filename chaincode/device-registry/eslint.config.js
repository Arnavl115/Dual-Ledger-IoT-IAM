const eslint = require('@eslint/js');
const globals = require('globals');

module.exports = [
    {
        ignores: ['node_modules/**'],
    },
    {
        files: ['**/*.js'],
        ...eslint.configs.recommended,
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: globals.node,
        },
        rules: {
            indent: ['error', 4],
            quotes: ['error', 'single', { allowTemplateLiterals: true }],
            semi: ['error', 'always'],
        },
    },
];
