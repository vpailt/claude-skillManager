import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { ReactNode } from "react";

interface ResizableSplitProps {
  storageId: string;
  left: ReactNode;
  right: ReactNode;
  defaultLeftSize?: number;
  minLeftSize?: number;
  maxLeftSize?: number;
  minRightSize?: number;
}

export function ResizableSplit({
  storageId,
  left,
  right,
  defaultLeftSize = 32,
  minLeftSize = 18,
  maxLeftSize = 60,
  minRightSize = 30,
}: ResizableSplitProps) {
  return (
    <PanelGroup
      direction="horizontal"
      autoSaveId={`skillmanager.${storageId}`}
      className="h-full w-full"
    >
      {/* Each half is a sub-window in its own right, not two regions of one:
          they carry the panel surface and the gutter between them is chrome
          showing through, which is why the handle draws no rule of its own. */}
      <Panel
        defaultSize={defaultLeftSize}
        minSize={minLeftSize}
        maxSize={maxLeftSize}
        className="panel flex h-full min-h-0 min-w-0 flex-col"
      >
        {left}
      </Panel>
      <PanelResizeHandle className="PanelResizeHandleOuter">
        <div className="PanelResizeHandleInner" />
      </PanelResizeHandle>
      <Panel
        minSize={minRightSize}
        className="panel flex h-full min-h-0 min-w-0 flex-col"
      >
        {right}
      </Panel>
    </PanelGroup>
  );
}
