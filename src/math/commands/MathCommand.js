import P from '../p.js'
import MathElement from './MathElement.js'
import L from '../var/L.js'
import R from '../var/R.js'
import {latexMathParser } from '../services/latex.js'
import {pray} from '../intro.js'
import MathBlock from './MathBlock.js'
var MathCommand = P(MathElement, function(_, super_) {
  _.init = function(ctrlSeq, htmlTemplate, textTemplate) {
    var cmd = this;
    super_.init.call(cmd);

    if (!cmd.ctrlSeq) cmd.ctrlSeq = ctrlSeq;
    if (htmlTemplate) cmd.htmlTemplate = htmlTemplate;
    if (textTemplate) cmd.textTemplate = textTemplate;
  };

  // obvious methods
  _.replaces = function(replacedFragment) {
    replacedFragment.disown();
    this.replacedFragment = replacedFragment;
  };
  _.isEmpty = function() {
    return this.foldChildren(true, function(isEmpty, child) {
      return isEmpty && child.isEmpty();
    });
  };

  _.parser = function() {
    var block = latexMathParser.block;
    var self = this;

    return block.times(self.numBlocks()).map(function(blocks) {
      self.blocks = blocks;

      for (var i = 0; i < blocks.length; i += 1) {
        blocks[i].adopt(self, self.ends[R], 0);
      }

      return self;
    });
  };

  // createLeftOf(cursor) and the methods it calls
  _.createLeftOf = function(cursor) {
    var cmd = this;
    var replacedFragment = cmd.replacedFragment;

    cmd.createBlocks();
    super_.createLeftOf.call(cmd, cursor);
    if (replacedFragment) {
      replacedFragment.adopt(cmd.ends[L], 0, 0);
      replacedFragment.jQ.appendTo(cmd.ends[L].jQ);
      cmd.placeCursor(cursor);
      cmd.prepareInsertionAt(cursor);
    }
    cmd.finalizeInsert(cursor.options);
    cmd.placeCursor(cursor);
  };
  _.createBlocks = function() {
    var cmd = this,
      numBlocks = cmd.numBlocks(),
      blocks = cmd.blocks = Array(numBlocks);

    for (var i = 0; i < numBlocks; i += 1) {
      var newBlock = blocks[i] = MathBlock();
      newBlock.adopt(cmd, cmd.ends[R], 0);
    }
  };
  _.placeCursor = function(cursor) {
    //insert the cursor at the right end of the first empty child, searching
    //left-to-right, or if none empty, the right end child
    cursor.insAtRightEnd(this.foldChildren(this.ends[L], function(leftward, child) {
      return leftward.isEmpty() ? leftward : child;
    }));
  };

  // editability methods: called by the cursor for editing, cursor movements,
  // and selection of the MathQuill tree, these all take in a direction and
  // the cursor
  _.moveTowards = function(dir, cursor, updown) {
    var updownInto = updown && this[updown+'Into'];
    cursor.insAtDirEnd(-dir, updownInto || this.ends[-dir]);
  };
  _.deleteTowards = function(dir, cursor) {
    if (this.isEmpty()) cursor[dir] = this.remove()[dir];
    else this.moveTowards(dir, cursor, null);
  };
  _.selectTowards = function(dir, cursor) {
    cursor[-dir] = this;
    cursor[dir] = this[dir];
  };
  _.selectChildren = function() {
    return Selection(this, this);
  };
  _.unselectInto = function(dir, cursor) {
    cursor.insAtDirEnd(-dir, cursor.anticursor.ancestors[this.id]);
  };
  _.seek = function(pageX, cursor) {
    function getBounds(node) {
      var bounds = {}
      bounds[L] = node.jQ.offset().left;
      bounds[R] = bounds[L] + node.jQ.outerWidth();
      return bounds;
    }

    var cmd = this;
    var cmdBounds = getBounds(cmd);

    if (pageX < cmdBounds[L]) return cursor.insLeftOf(cmd);
    if (pageX > cmdBounds[R]) return cursor.insRightOf(cmd);

    var leftLeftBound = cmdBounds[L];
    cmd.eachChild(function(block) {
      var blockBounds = getBounds(block);
      if (pageX < blockBounds[L]) {
        // closer to this block's left bound, or the bound left of that?
        if (pageX - leftLeftBound < blockBounds[L] - pageX) {
          if (block[L]) cursor.insAtRightEnd(block[L]);
          else cursor.insLeftOf(cmd);
        }
        else cursor.insAtLeftEnd(block);
        return false;
      }
      else if (pageX > blockBounds[R]) {
        if (block[R]) leftLeftBound = blockBounds[R]; // continue to next block
        else { // last (rightmost) block
          // closer to this block's right bound, or the cmd's right bound?
          if (cmdBounds[R] - pageX < pageX - blockBounds[R]) {
            cursor.insRightOf(cmd);
          }
          else cursor.insAtRightEnd(block);
        }
      }
      else {
        block.seek(pageX, cursor);
        return false;
      }
    });
  }

  // methods involved in creating and cross-linking with HTML DOM nodes
  /*
    They all expect an .htmlTemplate like
      '<span>&0</span>'
    or
      '<span><span>&0</span><span>&1</span></span>'

    See html.test.js for more examples.

    Requirements:
    - For each block of the command, there must be exactly one "block content
      marker" of the form '&<number>' where <number> is the 0-based index of the
      block. (Like the LaTeX \newcommand syntax, but with a 0-based rather than
      1-based index, because JavaScript because C because Dijkstra.)
    - The block content marker must be the sole contents of the containing
      element, there can't even be surrounding whitespace, or else we can't
      guarantee sticking to within the bounds of the block content marker when
      mucking with the HTML DOM.
    - The HTML not only must be well-formed HTML (of course), but also must
      conform to the XHTML requirements on tags, specifically all tags must
      either be self-closing (like '<br/>') or come in matching pairs.
      Close tags are never optional.

    Note that &<number> isn't well-formed HTML; if you wanted a literal '&123',
    your HTML template would have to have '&amp;123'.
  */
  _.numBlocks = function() {
    var matches = this.htmlTemplate.match(/&\d+/g);
    return matches ? matches.length : 0;
  };
  _.html = function() {
    // Render the entire math subtree rooted at this command, as HTML.
    // Expects .createBlocks() to have been called already, since it uses the
    // .blocks array of child blocks.
    //
    // See html.test.js for example templates and intended outputs.
    //
    // Given an .htmlTemplate as described above,
    // - insert the mathquill-command-id attribute into all top-level tags,
    //   which will be used to set this.jQ in .jQize().
    //   This is straightforward:
    //     * tokenize into tags and non-tags
    //     * loop through top-level tokens:
    //         * add #cmdId attribute macro to top-level self-closing tags
    //         * else add #cmdId attribute macro to top-level open tags
    //             * skip the matching top-level close tag and all tag pairs
    //               in between
    // - for each block content marker,
    //     + replace it with the contents of the corresponding block,
    //       rendered as HTML
    //     + insert the mathquill-block-id attribute into the containing tag
    //   This is even easier, a quick regex replace, since block tags cannot
    //   contain anything besides the block content marker.
    //
    // Two notes:
    // - The outermost loop through top-level tokens should never encounter any
    //   top-level close tags, because we should have first encountered a
    //   matching top-level open tag, all inner tags should have appeared in
    //   matching pairs and been skipped, and then we should have skipped the
    //   close tag in question.
    // - All open tags should have matching close tags, which means our inner
    //   loop should always encounter a close tag and drop nesting to 0. If
    //   a close tag is missing, the loop will continue until i >= tokens.length
    //   and token becomes undefined. This will not infinite loop, even in
    //   production without pray(), because it will then TypeError on .slice().

    var cmd = this;
    var blocks = cmd.blocks;
    var cmdId = ' mathquill-command-id=' + cmd.id;
    var tokens = cmd.htmlTemplate.match(/<[^<>]+>|[^<>]+/g);

    pray('no unmatched angle brackets', tokens.join('') === this.htmlTemplate);

    // add cmdId to all top-level tags
    for (var i = 0, token = tokens[0]; token; i += 1, token = tokens[i]) {
      // top-level self-closing tags
      if (token.slice(-2) === '/>') {
        tokens[i] = token.slice(0,-2) + cmdId + '/>';
      }
      // top-level open tags
      else if (token.charAt(0) === '<') {
        pray('not an unmatched top-level close tag', token.charAt(1) !== '/');

        tokens[i] = token.slice(0,-1) + cmdId + '>';

        // skip matching top-level close tag and all tag pairs in between
        var nesting = 1;
        do {
          i += 1, token = tokens[i];
          pray('no missing close tags', token);
          // close tags
          if (token.slice(0,2) === '</') {
            nesting -= 1;
          }
          // non-self-closing open tags
          else if (token.charAt(0) === '<' && token.slice(-2) !== '/>') {
            nesting += 1;
          }
        } while (nesting > 0);
      }
    }
    return tokens.join('').replace(/>&(\d+)/g, function($0, $1) {
      return ' mathquill-block-id=' + blocks[$1].id + '>' + blocks[$1].join('html');
    });
  };

  // methods to export a string representation of the math tree
  _.latex = function() {
    return this.foldChildren(this.ctrlSeq, function(latex, child) {
      return latex + '{' + (child.latex() || ' ') + '}';
    });
  };
  _.textTemplate = [''];
  _.text = function() {
    var cmd = this, i = 0;
    return cmd.foldChildren(cmd.textTemplate[i], function(text, child) {
      i += 1;
      var child_text = child.text();
      if (text && cmd.textTemplate[i] === '('
          && child_text[0] === '(' && child_text.slice(-1) === ')')
        return text + child_text.slice(1, -1) + cmd.textTemplate[i];
      return text + child_text + (cmd.textTemplate[i] || '');
    });
  };
});
export default MathCommand;