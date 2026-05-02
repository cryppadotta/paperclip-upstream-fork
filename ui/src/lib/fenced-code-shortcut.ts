import {
  $createCodeBlockNode,
  createRootEditorSubscription$,
  realmPlugin,
} from "@mdxeditor/editor";
import {
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
} from "lexical";

export function parseFenceShortcut(
  textBeforeCaret: string,
  textAfterCaret = "",
): string | null {
  if (textAfterCaret.trim().length > 0) return null;
  const match = /^[ \t]{0,3}```([\w-]+)?$/.exec(textBeforeCaret);
  return match ? match[1] ?? "" : null;
}

export const fencedCodeShortcutPlugin = realmPlugin({
  init(realm) {
    realm.pub(createRootEditorSubscription$, [
      (editor) => editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (event?.metaKey || event?.ctrlKey || event?.altKey || event?.shiftKey) {
            return false;
          }

          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
            return false;
          }

          const anchorNode = selection.anchor.getNode();
          if (!$isTextNode(anchorNode)) {
            return false;
          }

          const text = anchorNode.getTextContent();
          const language = parseFenceShortcut(
            text.slice(0, selection.anchor.offset),
            text.slice(selection.anchor.offset),
          );
          if (language === null) {
            return false;
          }

          const topLevel = anchorNode.getTopLevelElement();
          if (!topLevel || topLevel.getTextContent() !== text) {
            return false;
          }

          event?.preventDefault();
          const codeBlockNode = $createCodeBlockNode({ code: "", language, meta: "" });
          topLevel.replace(codeBlockNode);
          setTimeout(() => {
            codeBlockNode.select();
          }, 80);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    ]);
  },
});
