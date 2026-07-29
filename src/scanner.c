#include "tree_sitter/parser.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

enum TokenType {
  SCAN_KEYWORD,
  UNFOLD_KEYWORD,
  LINSPACE_KEYWORD,
  STEP_KEYWORD,
  CONTEXTUAL_KEYWORD_ERROR_SENTINEL,
};

static bool is_identifier_continue(int32_t codepoint) {
  return (codepoint >= 'a' && codepoint <= 'z') ||
         (codepoint >= 'A' && codepoint <= 'Z') ||
         (codepoint >= '0' && codepoint <= '9') || codepoint == '_';
}

static bool is_whitespace(int32_t codepoint) {
  return codepoint == ' ' || codepoint == '\t' || codepoint == '\r' ||
         codepoint == '\n';
}

static void skip_leading_whitespace(TSLexer *lexer) {
  while (is_whitespace(lexer->lookahead)) {
    lexer->advance(lexer, true);
  }
}

static bool skip_trivia_to(TSLexer *lexer, int32_t delimiter) {
  for (;;) {
    while (is_whitespace(lexer->lookahead)) {
      lexer->advance(lexer, false);
    }

    if (lexer->lookahead != '/') {
      return lexer->lookahead == delimiter;
    }

    // Graphcal has line comments only. A lone slash cannot precede the
    // delimiter that commits a contextual keyword, so consuming it while
    // checking for `//` is safe even when this scan ultimately fails.
    lexer->advance(lexer, false);
    if (lexer->lookahead != '/') {
      return false;
    }
    while (!lexer->eof(lexer) && lexer->lookahead != '\n' &&
           lexer->lookahead != '\r') {
      lexer->advance(lexer, false);
    }
  }
}

static bool word_equals(const char *word, size_t length, const char *expected,
                        size_t expected_length) {
  return length == expected_length &&
         memcmp(word, expected, expected_length) == 0;
}

void *tree_sitter_graphcal_external_scanner_create(void) { return NULL; }

void tree_sitter_graphcal_external_scanner_destroy(void *payload) {
  (void)payload;
}

unsigned tree_sitter_graphcal_external_scanner_serialize(void *payload,
                                                          char *buffer) {
  (void)payload;
  (void)buffer;
  return 0;
}

void tree_sitter_graphcal_external_scanner_deserialize(void *payload,
                                                        const char *buffer,
                                                        unsigned length) {
  (void)payload;
  (void)buffer;
  (void)length;
}

bool tree_sitter_graphcal_external_scanner_scan(void *payload, TSLexer *lexer,
                                                const bool *valid_symbols) {
  (void)payload;

  // During error recovery every external symbol is marked valid. Let the
  // internal identifier lexer recover instead of forcing a keyword token.
  if (valid_symbols[CONTEXTUAL_KEYWORD_ERROR_SENTINEL]) {
    return false;
  }

  // Comments are named extras and must stay visible in the syntax tree, so
  // leave them to Tree-sitter's internal lexer instead of skipping them here.
  skip_leading_whitespace(lexer);

  if (lexer->lookahead != 's' && lexer->lookahead != 'u' &&
      lexer->lookahead != 'l') {
    return false;
  }

  char word[8];
  size_t length = 0;
  while (is_identifier_continue(lexer->lookahead)) {
    if (length == sizeof(word)) {
      return false;
    }
    word[length++] = (char)lexer->lookahead;
    lexer->advance(lexer, false);
  }

  enum TokenType symbol;
  int32_t delimiter;
  if (valid_symbols[SCAN_KEYWORD] && word_equals(word, length, "scan", 4)) {
    symbol = SCAN_KEYWORD;
    delimiter = '(';
  } else if (valid_symbols[UNFOLD_KEYWORD] &&
             word_equals(word, length, "unfold", 6)) {
    symbol = UNFOLD_KEYWORD;
    delimiter = '(';
  } else if (valid_symbols[LINSPACE_KEYWORD] &&
             word_equals(word, length, "linspace", 8)) {
    symbol = LINSPACE_KEYWORD;
    delimiter = '(';
  } else if (valid_symbols[STEP_KEYWORD] &&
             word_equals(word, length, "step", 4)) {
    symbol = STEP_KEYWORD;
    delimiter = ':';
  } else {
    return false;
  }

  lexer->mark_end(lexer);
  if (!skip_trivia_to(lexer, delimiter)) {
    return false;
  }

  lexer->result_symbol = symbol;
  return true;
}
