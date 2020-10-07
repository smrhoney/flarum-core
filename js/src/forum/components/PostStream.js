import Component from '../../common/Component';
import ScrollListener from '../../common/utils/ScrollListener';
import PostLoading from './LoadingPost';
import ReplyPlaceholder from './ReplyPlaceholder';
import Button from '../../common/components/Button';

/**
 * The `PostStream` component displays an infinitely-scrollable wall of posts in
 * a discussion. Posts that have not loaded will be displayed as placeholders.
 *
 * ### Attrs
 *
 * - `discussion`
 * - `stream`
 * - `targetPost`
 * - `onPositionChange`
 */
export default class PostStream extends Component {
  oninit(vnode) {
    super.oninit(vnode);

    this.discussion = this.attrs.discussion;
    this.stream = this.attrs.stream;

    this.scrollListener = new ScrollListener(this.onscroll.bind(this));
  }

  view() {
    let lastTime;

    const viewingEnd = this.stream.viewingEnd();
    const posts = this.stream.posts();
    const postIds = this.discussion.postIds();

    const items = posts.map((post, i) => {
      let content;
      const attrs = { 'data-index': this.stream.visibleStart + i };

      if (post) {
        const time = post.createdAt();
        const PostComponent = app.postComponents[post.contentType()];
        content = PostComponent ? PostComponent.component({ post }) : '';

        attrs.key = 'post' + post.id();
        attrs['data-time'] = time.toISOString();
        attrs['data-number'] = post.number();
        attrs['data-id'] = post.id();
        attrs['data-type'] = post.contentType();

        // If the post before this one was more than 4 days ago, we will
        // display a 'time gap' indicating how long it has been in between
        // the posts.
        const dt = time - lastTime;

        if (dt > 1000 * 60 * 60 * 24 * 4) {
          content = [
            <div className="PostStream-timeGap">
              <span>{app.translator.trans('core.forum.post_stream.time_lapsed_text', { period: dayjs().add(dt, 'ms').fromNow(true) })}</span>
            </div>,
            content,
          ];
        }

        lastTime = time;
      } else {
        attrs.key = 'post' + postIds[this.stream.visibleStart + i];

        content = PostLoading.component();
      }

      return (
        <div className="PostStream-item" {...attrs}>
          {content}
        </div>
      );
    });

    if (!viewingEnd && posts[this.stream.visibleEnd - this.stream.visibleStart - 1]) {
      items.push(
        <div className="PostStream-loadMore" key="loadMore">
          <Button className="Button" onclick={this.stream.loadNext.bind(this.stream)}>
            {app.translator.trans('core.forum.post_stream.load_more_button')}
          </Button>
        </div>
      );
    }

    // If we're viewing the end of the discussion, the user can reply, and
    // is not already doing so, then show a 'write a reply' placeholder.
    if (viewingEnd && (!app.session.user || this.discussion.canReply())) {
      items.push(
        <div className="PostStream-item" key="reply" data-index={this.stream.count()}>
          {ReplyPlaceholder.component({ discussion: this.discussion })}
        </div>
      );
    }

    return <div className="PostStream">{items}</div>;
  }

  onupdate() {
    this.triggerScroll();
  }

  oncreate(vnode) {
    super.oncreate(vnode);

    this.triggerScroll();

    // This is wrapped in setTimeout due to the following Mithril issue:
    // https://github.com/lhorie/mithril.js/issues/637
    setTimeout(() => this.scrollListener.start());
  }

  onremove() {
    this.scrollListener.stop();
    clearTimeout(this.calculatePositionTimeout);
  }

  /**
   * Start scrolling, if appropriate, to a newly-targeted post.
   */
  triggerScroll() {
    if (!this.stream.needsScroll) return;

    const target = this.stream.targetPost;
    this.stream.needsScroll = false;

    if ('number' in target) {
      this.scrollToNumber(target.number, this.stream.animateScroll);
    } else if ('index' in target) {
      this.scrollToIndex(target.index, this.stream.animateScroll, target.reply);
    }
  }

  /**
   * When the window is scrolled, check if either extreme of the post stream is
   * in the viewport, and if so, trigger loading the next/previous page.
   *
   * @param {Integer} top
   */
  onscroll(top = window.pageYOffset) {
    if (this.stream.paused) return;
    const marginTop = this.getMarginTop();
    const viewportHeight = $(window).height() - marginTop;
    const viewportTop = top + marginTop;
    const loadAheadDistance = 300;

    if (this.stream.visibleStart > 0) {
      const $item = this.$('.PostStream-item[data-index=' + this.stream.visibleStart + ']');

      if ($item.length && $item.offset().top > viewportTop - loadAheadDistance) {
        this.stream.loadPrevious();
      }
    }

    if (this.stream.visibleEnd < this.stream.count()) {
      const $item = this.$('.PostStream-item[data-index=' + (this.stream.visibleEnd - 1) + ']');

      if ($item.length && $item.offset().top + $item.outerHeight(true) < viewportTop + viewportHeight + loadAheadDistance) {
        this.stream.loadNext();
      }
    }

    // Throttle calculation of our position (start/end numbers of posts in the
    // viewport) to 100ms.
    clearTimeout(this.calculatePositionTimeout);
    this.calculatePositionTimeout = setTimeout(this.calculatePosition.bind(this, top), 100);

    this.updateScrubber(top);
  }

  updateScrubber(top = window.pageYOffset) {
    const marginTop = this.getMarginTop();
    const viewportHeight = $(window).height() - marginTop;
    const viewportTop = top + marginTop;

    // Before looping through all of the posts, we reset the scrollbar
    // properties to a 'default' state. These values reflect what would be
    // seen if the browser were scrolled right up to the top of the page,
    // and the viewport had a height of 0.
    const $items = this.$('.PostStream-item[data-index]');
    let index = $items.first().data('index') || 0;
    let visible = 0;
    let period = '';

    // Now loop through each of the items in the discussion. An 'item' is
    // either a single post or a 'gap' of one or more posts that haven't
    // been loaded yet.
    $items.each(function () {
      const $this = $(this);
      const top = $this.offset().top;
      const height = $this.outerHeight(true);

      // If this item is above the top of the viewport, skip to the next
      // one. If it's below the bottom of the viewport, break out of the
      // loop.
      if (top + height < viewportTop) {
        return true;
      }
      if (top > viewportTop + viewportHeight) {
        return false;
      }

      // Work out how many pixels of this item are visible inside the viewport.
      // Then add the proportion of this item's total height to the index.
      const visibleTop = Math.max(0, viewportTop - top);
      const visibleBottom = Math.min(height, viewportTop + viewportHeight - top);
      const visiblePost = visibleBottom - visibleTop;

      if (top <= viewportTop) {
        index = parseFloat($this.data('index')) + visibleTop / height;
      }

      if (visiblePost > 0) {
        visible += visiblePost / height;
      }

      // If this item has a time associated with it, then set the
      // scrollbar's current period to a formatted version of this time.
      const time = $this.data('time');
      if (time) period = time;
    });

    this.stream.index = index + 1;
    this.stream.visible = visible;
    if (period) this.stream.description = dayjs(period).format('MMMM YYYY');
  }

  /**
   * Work out which posts (by number) are currently visible in the viewport, and
   * fire an event with the information.
   */
  calculatePosition(top = window.pageYOffset) {
    const marginTop = this.getMarginTop();
    const $window = $(window);
    const viewportHeight = $window.height() - marginTop;
    const scrollTop = $window.scrollTop() + marginTop;
    const viewportTop = top + marginTop;

    let startNumber;
    let endNumber;

    this.$('.PostStream-item').each(function () {
      const $item = $(this);
      const top = $item.offset().top;
      const height = $item.outerHeight(true);
      const visibleTop = Math.max(0, viewportTop - top);

      const threeQuartersVisible = visibleTop / height < 0.75;
      const coversQuarterOfViewport = (height - visibleTop) / viewportHeight > 0.25;
      if (startNumber === undefined && (threeQuartersVisible || coversQuarterOfViewport)) {
        startNumber = $item.data('number');
      }

      if (top + height > scrollTop) {
        if (top + height < scrollTop + viewportHeight) {
          if ($item.data('number')) {
            endNumber = $item.data('number');
          }
        } else return false;
      }
    });

    if (startNumber) {
      this.attrs.onPositionChange(startNumber || 1, endNumber, startNumber);
    }
  }

  /**
   * Get the distance from the top of the viewport to the point at which we
   * would consider a post to be the first one visible.
   *
   * @return {Integer}
   */
  getMarginTop() {
    return this.$() && $('#header').outerHeight() + parseInt(this.$().css('margin-top'), 10);
  }

  /**
   * Scroll down to a certain post by number and 'flash' it.
   *
   * @param {Integer} number
   * @param {Boolean} animate
   * @return {jQuery.Deferred}
   */
  scrollToNumber(number, animate) {
    const $item = this.$(`.PostStream-item[data-number=${number}]`);

    return this.scrollToItem($item, animate).then(this.flashItem.bind(this, $item));
  }

  /**
   * Scroll down to a certain post by index.
   *
   * @param {Integer} index
   * @param {Boolean} animate
   * @param {Boolean} reply Whether or not to scroll to the reply placeholder.
   * @return {jQuery.Deferred}
   */
  scrollToIndex(index, animate, reply) {
    if (reply) {
      const $placeholder = this.$('.PostStream-item:last-child');
      this.scrollToItem($placeholder, animate, true, true);
      this.flashItem($placeholder);
    } else {
      this.scrollToItem(this.$(`.PostStream-item[data-index=${index}]`), animate, true);
    }
  }

  /**
   * Scroll down to the given post.
   *
   * @param {jQuery} $item
   * @param {Boolean} animate
   * @param {Boolean} force Whether or not to force scrolling to the item, even
   *     if it is already in the viewport.
   * @param {Boolean} reply Whether or not to scroll to the reply placeholder.
   * @return {jQuery.Deferred}
   */
  scrollToItem($item, animate, force, reply) {
    const $container = $('html, body').stop(true);
    const index = $item.data('index');

    if ($item.length) {
      const itemTop = $item.offset().top - this.getMarginTop();
      const itemBottom = $item.offset().top + $item.height();
      const scrollTop = $(document).scrollTop();
      const scrollBottom = scrollTop + $(window).height();

      // If the item is already in the viewport, we may not need to scroll.
      // If we're scrolling to the reply placeholder, we'll make sure its
      // bottom will line up with the top of the composer.
      if (force || itemTop < scrollTop || itemBottom > scrollBottom) {
        const top = reply ? itemBottom - $(window).height() + app.composer.computedHeight() : $item.is(':first-child') ? 0 : itemTop;

        if (!animate) {
          $container.scrollTop(top);
        } else if (top !== scrollTop) {
          $container.animate({ scrollTop: top }, 'fast');
        }
      }
    }

    const updateScrubberHeight = () => {
      // We manually set the index because we want to display the index of the
      // exact post we've scrolled to, not just that of the first post within viewport.
      this.updateScrubber();
      this.stream.index = index;
    };

    // If we don't update this before the scroll, the scrubber will start
    // at the top, and animate down, which can be confusing
    updateScrubberHeight();
    this.stream.forceUpdateScrubber = true;

    return Promise.all([$container.promise(), this.stream.loadPromise]).then(() => {
      m.redraw.sync();

      // Rendering post contents will probably throw off our position.
      // To counter this, we'll scroll either:
      //   - To the top of the page if we're on the first post
      //   - To the reply placeholder (aligned with composer top)
      //   - To the top of a post (if that post exists)
      // If the post does not currently exist, it's probably
      // outside of the range we loaded in, so we won't adjust anything,
      // as it will soon be rendered by the "load more" system.
      const $item = $(`.PostStream-item[data-index=${index}]`);
      if (index === 0) {
        $(window).scrollTop(0);
      } else if ($item.offset() && reply) {
        $(window).scrollTop($item.offset().top + $item.height() - $(window).height() + app.composer.computedHeight());
      } else if ($item.offset()) {
        $(window).scrollTop($item.offset().top - this.getMarginTop());
      }

      // We want to adjust this again after posts have been loaded in
      // and position adjusted so that the scrubber's height is accurate.
      updateScrubberHeight();

      this.calculatePosition();
      this.stream.paused = false;
    });
  }

  /**
   * 'Flash' the given post, drawing the user's attention to it.
   *
   * @param {jQuery} $item
   */
  flashItem($item) {
    $item.addClass('flash').on('animationend webkitAnimationEnd', (e) => {
      if (e.animationName === 'fadeIn') {
        $item.removeClass('flash');
      }
    });
  }
}
