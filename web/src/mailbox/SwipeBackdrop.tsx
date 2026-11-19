import { Icon } from "@astryxdesign/core/Icon";
import {
  ArchiveBoxIcon,
  ArrowUturnLeftIcon,
  InboxArrowDownIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import type { SwipeAction } from "./actions";
import type { SwipeView } from "./useRowGestures";

const ICONS: Record<SwipeAction, typeof ArchiveBoxIcon> = {
  archive: ArchiveBoxIcon,
  unarchive: InboxArrowDownIcon,
  trash: TrashIcon,
  restore: ArrowUturnLeftIcon,
  notSpam: InboxArrowDownIcon,
};

/**
 * What a swiped row uncovers: the action's icon, in a neutral colour until the swipe is past the
 * arm point, then in the action's own colour. The action has a toolbar button, so the icon needs
 * no name of its own (docs/M8-mailbox-ux.md, decision 4).
 */
export function SwipeBackdrop({ view }: { view: SwipeView }) {
  const action = view.action as SwipeAction;
  return (
    <div
      className="mail-swipe-backdrop"
      aria-hidden="true"
      data-side={view.side}
      data-armed={view.armed}
      data-tone={action === "trash" ? "error" : "accent"}
      style={{ top: view.top, height: view.height }}
    >
      <Icon icon={ICONS[action]} />
    </div>
  );
}
