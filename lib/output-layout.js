'use strict';

const path = require('node:path');

function deriveOutputLayout(outputDir, languageValue) {
  const liveOutDir = path.resolve(outputDir);
  const language = String(languageValue || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(language)
    || language === '.'
    || language === '..') {
    throw new Error(`unsafe wiki language: ${languageValue}`);
  }

  const languageDir = path.dirname(liveOutDir);
  const structured = path.basename(liveOutDir) === 'content'
    && path.basename(languageDir) === language;
  const localWikiRoot = structured
    ? path.dirname(languageDir)
    : `${liveOutDir}.local-wiki`;

  return {
    localWikiRoot,
    metaDir: path.join(languageDir, 'meta'),
    knowledgeBase: path.join(localWikiRoot, 'knowledge', language),
    runsDir: path.join(localWikiRoot, 'runs'),
    structured,
  };
}

module.exports = {
  deriveOutputLayout,
};
