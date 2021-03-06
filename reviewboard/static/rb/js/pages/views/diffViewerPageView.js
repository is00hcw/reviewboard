/*
 * Manages the diff viewer page.
 *
 * This provides functionality for the diff viewer page for managing the
 * loading and display of diffs, and all navigation around the diffs.
 */
RB.DiffViewerPageView = RB.ReviewablePageView.extend({
    SCROLL_BACKWARD: -1,
    SCROLL_FORWARD: 1,

    ANCHOR_COMMENT: 1,
    ANCHOR_FILE: 2,
    ANCHOR_CHUNK: 4,

    DIFF_SCROLLDOWN_AMOUNT: 100,

    keyBindings: {
        'aAKP<m': '_selectPreviousFile',
        'fFJN>': '_selectNextFile',
        'sSkp,': '_selectPreviousDiff',
        'dDjn.': '_selectNextDiff',
        '[x': '_selectPreviousComment',
        ']c': '_selectNextComment',
        '\x0d': '_recenterSelected'
    },

    events: _.extend({
        'click .toggle-whitespace-only-chunks': '_toggleWhitespaceOnlyChunks',
        'click .toggle-show-whitespace': '_toggleShowExtraWhitespace'
    }, RB.ReviewablePageView.prototype.events),

    /*
     * Initializes the diff viewer page.
     */
    initialize: function() {
        var url;

        _.super(this).initialize.call(this);

        this._selectedAnchorIndex = -1;
        this._$anchors = $();
        this._$controls = null;
        this._diffReviewableViews = [];
        this._diffFileIndexView = null;

        this.listenTo(this.model.get('files'), 'update', this._setFiles);

        /* Check to see if there's an anchor we need to scroll to. */
        url = document.location.toString();
        this._startAtAnchorName = (url.match('#') ? url.split('#')[1] : null);

        this.router = new Backbone.Router({
            routes: {
                ':revision/': 'revision'
            }
        });
        this.listenTo(this.router, 'route:revision', function(revision) {
            var parts;

            if (revision.indexOf('-') === -1) {
                this._loadRevision(0, parseInt(revision, 10));
            } else {
                parts = revision.split('-', 2);
                this._loadRevision(parseInt(parts[0], 10),
                                   parseInt(parts[1], 10));
            }
        });

        /*
         * If we have the "index_header" hash in the location, strip it off.
         * Backbone's router makes use of the hash to try to be backwards
         * compatible with browsers that don't support the history API, but we
         * don't care about those, and if it's present when we call
         * start(), it will change the page's URL to be /diff/index_header,
         * which isn't a valid URL.
         */
        if (window.location.hash === '#index_header') {
            window.location.hash = '';
        }

        Backbone.history.start({
            pushState: true,
            hashChange: false,
            root: this.options.reviewRequestData.reviewURL + 'diff/',
            silent: true
        });
    },

    /*
     * Removes the view from the page.
     */
    remove: function() {
        _.super(this).remove.call(this);

        this._diffFileIndexView.remove();
    },

    /*
     * Renders the page and begins loading all diffs.
     */
    render: function() {
        var $reviewRequest,
            numDiffs = this.model.get('numDiffs'),
            revisionModel = this.model.get('revision');

        _.super(this).render.call(this);

        $reviewRequest = this.$('.review-request');

        this._$controls = $reviewRequest.find('ul.controls');

        this._diffFileIndexView = new RB.DiffFileIndexView({
            el: $('#diff_index'),
            collection: this.model.get('files')
        });
        this._diffFileIndexView.render();

        this.listenTo(this._diffFileIndexView, 'anchorClicked',
                      this.selectAnchorByName);

        this._diffRevisionLabelView = new RB.DiffRevisionLabelView({
            el: $('#diff_revision_label'),
            model: revisionModel
        });
        this._diffRevisionLabelView.render();

        this.listenTo(this._diffRevisionLabelView, 'revisionSelected',
                      this._onRevisionSelected);

        if (numDiffs > 1) {
            this._diffRevisionSelectorView = new RB.DiffRevisionSelectorView({
                el: $('#diff_revision_selector'),
                model: revisionModel,
                numDiffs: numDiffs
            });
            this._diffRevisionSelectorView.render();

            this.listenTo(this._diffRevisionSelectorView, 'revisionSelected',
                          this._onRevisionSelected);
        }

        this._commentsHintModel = this.options.commentsHint;
        this._commentsHintView = new RB.DiffCommentsHintView({
            el: $('#diff_comments_hint'),
            model: this.model.get('commentsHint')
        });
        this._commentsHintView.render();
        this.listenTo(this._commentsHintView, 'revisionSelected',
                      this._onRevisionSelected);

        this._paginationView = new RB.PaginationView({
            el: $('#pagination'),
            model: this.model.get('pagination')
        });
        this._paginationView.render();

        $('#diffs').bindClass(RB.UserSession.instance,
                              'diffsShowExtraWhitespace', 'ewhl');

        this._setFiles();

        return this;
    },

    _fileEntryTemplate: _.template([
        '<div class="diff-container">',
        ' <div class="diff-box">',
        '  <table class="sidebyside loading <% if (newfile) { %>newfile<% } %>"',
        '         id="file_container_<%- id %>">',
        '   <thead>',
        '    <tr class="filename-row">',
        '     <th colspan="2"><%- depotFilename %></th>',
        '    </tr>',
        '    <tr class="revision-row">',
        '    <th><%- revision %></th>',
        '    <th><%- destRevision %></th>',
        '    </tr>',
        '   </thead>',
        '   <tbody>',
        '    <tr><td colspan="2"><pre>&nbsp;</pre></td></tr>',
        '   </tbody>',
        '  </table>',
        ' </div>',
        '</div>'
    ].join('')),

    /*
     * Set the displayed files.
     *
     * This will replace the displayed files with a set of pending entries,
     * queue loads for each file, and start the queue.
     */
    _setFiles: function() {
        var files = this.model.get('files'),
            $diffs = $('#diffs').empty();

        files.each(function(file) {
            var filediff = file.get('filediff'),
                interfilediff = file.get('interfilediff');

            $diffs.append(this._fileEntryTemplate(file.attributes));

            this.queueLoadDiff(filediff.id,
                               filediff.revision,
                               interfilediff ? interfilediff.id : null,
                               interfilediff ? interfilediff.revision : null,
                               file.get('index'),
                               file.get('commentCounts'));
        }, this);

        $.funcQueue('diff_files').start();
    },

    /*
     * Queues loading of a diff.
     *
     * When the diff is loaded, it will be placed into the appropriate location
     * in the diff viewer. The anchors on the page will be rebuilt. This will
     * then trigger the loading of the next file.
     */
    queueLoadDiff: function(fileDiffID, fileDiffRevision,
                            interFileDiffID, interdiffRevision,
                            fileIndex, serializedCommentBlocks) {
        var diffReviewable = new RB.DiffReviewable({
            reviewRequest: this.reviewRequest,
            fileIndex: fileIndex,
            fileDiffID: fileDiffID,
            interFileDiffID: interFileDiffID,
            revision: fileDiffRevision,
            interdiffRevision: interdiffRevision,
            serializedCommentBlocks: serializedCommentBlocks
        });

        $.funcQueue('diff_files').add(function() {
            if ($('#file' + fileDiffID).length === 1) {
                /*
                 * We already have this one. This is probably a pre-loaded file.
                 */
                this._renderFileDiff(diffReviewable);
            } else {
                diffReviewable.getRenderedDiff({
                    complete: function(xhr) {
                        $('#file_container_' + fileDiffID)
                            .replaceWith(xhr.responseText);
                        this._renderFileDiff(diffReviewable);
                    }
                }, this);
            }
        }, this);
    },

    /*
     * Sets up a diff as DiffReviewableView and renders it.
     *
     * This will set up a DiffReviewableView for the given diffReviewable.
     * The anchors from this diff render will be stored for navigation.
     *
     * Once rendered and set up, the next diff in the load queue will be
     * pulled from the server.
     */
    _renderFileDiff: function(diffReviewable) {
        var diffReviewableView = new RB.DiffReviewableView({
                el: $('#file' + diffReviewable.get('fileDiffID')),
                model: diffReviewable
            }),
            $anchor;

        this._diffFileIndexView.addDiff(this._diffReviewableViews.length,
                                        diffReviewableView);

        this._diffReviewableViews.push(diffReviewableView);
        diffReviewableView.render();

        this.listenTo(diffReviewableView, 'fileClicked', function() {
            this.selectAnchorByName(diffReviewable.get('fileIndex'));
        });

        this.listenTo(diffReviewableView, 'chunkClicked', function(name) {
            this.selectAnchorByName(name, false);
        });

        /* We must rebuild this every time. */
        this._updateAnchors(diffReviewableView.$el);

        this.listenTo(diffReviewableView, 'chunkExpansionChanged', function() {
            /* The selection rectangle may not update -- bug #1353. */
            this._highlightAnchor($(this._$anchors[this._selectedAnchorIndex]));
        });

        if (this._startAtAnchorName) {
            /* See if we've loaded the anchor the user wants to start at. */
            $anchor = $('a[name="' + this._startAtAnchorName + '"]');

            if ($anchor.length !== 0) {
                this.selectAnchor($anchor);
                this._startAtAnchorName = null;
            }
        }

        $.funcQueue('diff_files').next();
    },

    /*
     * Selects the anchor at a specified location.
     *
     * By default, this will scroll the page to position the anchor near
     * the top of the view.
     */
    selectAnchor: function($anchor, scroll) {
        var i;

        if (!$anchor || $anchor.length === 0 ||
            $anchor.parent().is(':hidden')) {
            return false;
        }

        if (scroll !== false) {
            $(window).scrollTop($anchor.offset().top -
                                this.DIFF_SCROLLDOWN_AMOUNT);
        }

        this._highlightAnchor($anchor);

        for (i = 0; i < this._$anchors.length; i++) {
            if (this._$anchors[i] === $anchor[0]) {
                this._selectedAnchorIndex = i;
                break;
            }
        }

        return true;
    },

    /*
     * Selects an anchor by name.
     */
    selectAnchorByName: function(name, scroll) {
        return this.selectAnchor($('a[name="' + name + '"]'), scroll);
    },

    /*
     * Highlights a chunk bound to an anchor element.
     */
    _highlightAnchor: function($anchor) {
        RB.ChunkHighlighterView.highlight(
            $anchor.parents('tbody:first, thead:first'));
    },

    /*
     * Updates the list of known anchors based on named anchors in the
     * specified table. This is called after every part of the diff that we
     * loaded.
     *
     * If no anchor is selected, we'll try to select the first one.
     */
    _updateAnchors: function($table) {
        this._$anchors = this._$anchors.add($table.find('a[name]'));

        /* Skip over the change index to the first item. */
        if (this._selectedAnchorIndex === -1 && this._$anchors.length > 0) {
            this._selectedAnchorIndex = 0;
            this._highlightAnchor($(this._$anchors[this._selectedAnchorIndex]));
        }
    },

    /*
     * Returns the next navigatable anchor in the specified direction of
     * the given types.
     *
     * This will take a direction to search, starting at the currently
     * selected anchor. The next anchor matching one of the types in the
     * anchorTypes bitmask will be returned. If no anchor is found,
     * null will be returned.
     */
    _getNextAnchor: function(dir, anchorTypes) {
        var $anchor,
            i;

        for (i = this._selectedAnchorIndex + dir;
             i >= 0 && i < this._$anchors.length;
             i += dir) {
            $anchor = $(this._$anchors[i]);

            if (((anchorTypes & this.ANCHOR_COMMENT) &&
                 $anchor.hasClass('comment-anchor')) ||
                ((anchorTypes & this.ANCHOR_FILE) &&
                 $anchor.hasClass('file-anchor')) ||
                ((anchorTypes & this.ANCHOR_CHUNK) &&
                 $anchor.hasClass('chunk-anchor'))) {
                return $anchor;
            }
        }

        return null;
    },

    /*
     * Selects the previous file's header on the page.
     */
    _selectPreviousFile: function() {
        this.selectAnchor(this._getNextAnchor(this.SCROLL_BACKWARD,
                                              this.ANCHOR_FILE));
    },

    /*
     * Selects the next file's header on the page.
     */
    _selectNextFile: function() {
        this.selectAnchor(this._getNextAnchor(this.SCROLL_FORWARD,
                                              this.ANCHOR_FILE));
    },

    /*
     * Selects the previous diff chunk on the page.
     */
    _selectPreviousDiff: function() {
        this.selectAnchor(
            this._getNextAnchor(this.SCROLL_BACKWARD,
                                this.ANCHOR_CHUNK | this.ANCHOR_FILE));
    },

    /*
     * Selects the next diff chunk on the page.
     */
    _selectNextDiff: function() {
        this.selectAnchor(
            this._getNextAnchor(this.SCROLL_FORWARD,
                                this.ANCHOR_CHUNK | this.ANCHOR_FILE));
    },

    /*
     * Selects the previous comment on the page.
     */
    _selectPreviousComment: function() {
        this.selectAnchor(
            this._getNextAnchor(this.SCROLL_BACKWARD, this.ANCHOR_COMMENT));
    },

    /*
     * Selects the next comment on the page.
     */
    _selectNextComment: function() {
        this.selectAnchor(
            this._getNextAnchor(this.SCROLL_FORWARD, this.ANCHOR_COMMENT));
    },

    /*
     * Re-centers the currently selected area on the page.
     */
    _recenterSelected: function() {
        this.selectAnchor($(this._$anchors[this._selectedAnchorIndex]));
    },

    /*
     * Toggles the display of diff chunks that only contain whitespace changes.
     */
    _toggleWhitespaceOnlyChunks: function() {
        _.each(this._diffReviewableViews, function(diffReviewableView) {
            diffReviewableView.toggleWhitespaceOnlyChunks();
        });

        this._$controls.find('.ws').toggle();

        return false;
    },

    /*
     * Toggles the display of extra whitespace highlights on diffs.
     *
     * A cookie will be set to the new whitespace display setting, so that
     * the new option will be the default when viewing diffs.
     */
    _toggleShowExtraWhitespace: function() {
        this._$controls.find('.ew').toggle();
        RB.UserSession.instance.toggleAttr('diffsShowExtraWhitespace');

        return false;
    },

    /*
     * Callback for when a new revision is selected.
     *
     * This supports both single revisions and interdiffs. If `base` is 0, a
     * single revision is selected. If not, the interdiff between `base` and
     * `tip` will be shown.
     */
    _onRevisionSelected: function(base, tip) {
        if (base === 0) {
            this.router.navigate(tip + '/', {trigger: true});
        } else {
            this.router.navigate(base + '-' + tip + '/', {trigger: true});
        }
    },

    /*
     * Load a given revision.
     *
     * This supports both single revisions and interdiffs. If `base` is 0, a
     * single revision is selected. If not, the interdiff between `base` and
     * `tip` will be shown.
     */
    _loadRevision: function(base, tip) {
        var reviewRequestURL = _.result(this.reviewRequest, 'url'),
            contextURL = reviewRequestURL + 'diff-context/';

        if (base === 0) {
            contextURL += '?revision=' + tip;
        } else {
            contextURL += '?revision=' + base + '&interdiff_revision=' + tip;
        }

        $.ajax(contextURL).done(_.bind(function(rsp) {
            _.each(this._diffReviewableViews, function(diffReviewableView) {
                diffReviewableView.remove();
            });
            this._diffReviewableViews = [];

            this.model.set(this.model.parse(rsp.diff_context));
        }, this));
    }
});
_.extend(RB.DiffViewerPageView.prototype, RB.KeyBindingsMixin);
