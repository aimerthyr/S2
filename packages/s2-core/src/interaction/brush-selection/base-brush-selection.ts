import type { Event as CanvasEvent, IShape, Point } from '@antv/g-canvas';
import { cloneDeep, isEmpty, isNil, last, map, throttle } from 'lodash';
import { ColCell, DataCell, RowCell } from '../../cell';
import {
  FRONT_GROUND_GROUP_BRUSH_SELECTION_Z_INDEX,
  InteractionStateName,
  InterceptType,
  S2Event,
  ScrollDirection,
} from '../../common/constant';
import {
  BRUSH_AUTO_SCROLL_INITIAL_CONFIG,
  InteractionBrushSelectionStage,
  ScrollDirectionRowIndexDiff,
} from '../../common/constant/interaction';
import type {
  BrushAutoScrollConfig,
  BrushPoint,
  BrushRange,
  OffsetConfig,
  OnUpdateCells,
  Rect,
  S2CellType,
  ViewMeta,
} from '../../common/interface';
import type { TableFacet } from '../../facet';
import type { Node } from '../../facet/layout/node';
import {
  isFrozenCol,
  isFrozenRow,
  isFrozenTrailingCol,
  isFrozenTrailingRow,
} from '../../facet/utils';
import { getCellsTooltipData } from '../../utils';
import {
  getCellMeta,
  getScrollOffsetForCol,
  getScrollOffsetForRow,
} from '../../utils/interaction';
import { getValidFrozenOptions } from '../../utils/layout/frozen';
import type { BaseEventImplement } from '../base-event';
import { BaseEvent } from '../base-interaction';

/**
 * 刷选基类, dataCell, rowCell, colCell 支持滚动刷选
 */
export class BaseBrushSelection
  extends BaseEvent
  implements BaseEventImplement
{
  public displayedCells: S2CellType[] = [];

  public prepareSelectMaskShape: IShape;

  public startBrushPoint: BrushPoint;

  public endBrushPoint: BrushPoint;

  public brushRangeCells: S2CellType[] = [];

  public brushSelectionStage = InteractionBrushSelectionStage.UN_DRAGGED;

  public brushSelectionMinimumMoveDistance = 5;

  public scrollAnimationComplete = true;

  public mouseMoveDistanceFromCanvas = 0;

  public bindEvents() {
    this.bindMouseDown();
    this.bindMouseMove();
    this.bindMouseUp();
  }

  protected getPrepareSelectMaskTheme() {
    return this.spreadsheet.theme?.prepareSelectMask;
  }

  protected initPrepareSelectMaskShape() {
    const { foregroundGroup } = this.spreadsheet;
    if (!foregroundGroup) {
      return;
    }
    foregroundGroup.removeChild(this.prepareSelectMaskShape);
    const prepareSelectMaskTheme = this.getPrepareSelectMaskTheme();
    this.prepareSelectMaskShape = foregroundGroup.addShape('rect', {
      visible: false,
      attrs: {
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        fill: prepareSelectMaskTheme?.backgroundColor,
        fillOpacity: prepareSelectMaskTheme?.backgroundOpacity,
        zIndex: FRONT_GROUND_GROUP_BRUSH_SELECTION_Z_INDEX,
      },
      capture: false,
    });
  }

  protected setBrushSelectionStage(stage: InteractionBrushSelectionStage) {
    this.brushSelectionStage = stage;
  }

  // 默认是 Data cell 的绘制区
  protected isPointInCanvas(point: Point): boolean {
    const { height, width } = this.spreadsheet.facet.getCanvasHW();
    const { minX, minY } = this.spreadsheet.facet.panelBBox;

    return (
      point.x > minX && point.x < width && point.y > minY && point.y < height
    );
  }

  private setMoveDistanceFromCanvas = (
    delta: { x: number; y: number },
    needScrollForX: boolean,
    needScrollForY: boolean,
  ) => {
    let deltaVal = 0;

    if (needScrollForX) {
      deltaVal = delta.x;
    }

    if (needScrollForY) {
      const deltaY = delta.y;

      if (needScrollForX) {
        deltaVal = Math.max(deltaY, deltaVal);
      } else {
        deltaVal = deltaY;
      }
    }

    this.mouseMoveDistanceFromCanvas = Math.abs(deltaVal);
  };

  public formatBrushPointForScroll = (delta: Point, isRowHeader = false) => {
    const { x, y } = delta;
    const { facet } = this.spreadsheet;
    const { minX, maxX } = isRowHeader ? facet.cornerBBox : facet.panelBBox;
    const { minY, maxY } = facet.panelBBox;

    let newX = this.endBrushPoint?.x + x;
    let newY = this.endBrushPoint?.y + y;
    let needScrollForX = true;
    let needScrollForY = true;
    const vScrollBarWidth = facet.vScrollBar?.getBBox()?.width;
    const extraPixel = 2; // 额外加缩进，保证 getShape 在 panelBox 内

    if (newX > maxX) {
      newX = maxX - vScrollBarWidth - extraPixel;
    } else if (newX < minX) {
      newX = minX + extraPixel;
    } else {
      needScrollForX = false;
    }

    if (newY > maxY) {
      newY = maxY - extraPixel;
    } else if (newY <= minY) {
      newY = minY + extraPixel;
    } else {
      needScrollForY = false;
    }

    return {
      x: {
        value: newX,
        needScroll: needScrollForX,
      },
      y: {
        value: newY,
        needScroll: needScrollForY,
      },
    };
  };

  // 矩形相交算法: 通过判断两矩形左右上下的线是否相交
  public rectanglesIntersect = (rect1: Rect, rect2: Rect) => {
    return (
      rect1.maxX > rect2.minX &&
      rect1.minX < rect2.maxX &&
      rect1.minY < rect2.maxY &&
      rect1.maxY > rect2.minY
    );
  };

  private autoScrollIntervalId = null;

  protected autoScrollConfig: BrushAutoScrollConfig = cloneDeep(
    BRUSH_AUTO_SCROLL_INITIAL_CONFIG,
  );

  public validateYIndex = (yIndex: number) => {
    const { facet } = this.spreadsheet;
    const frozenInfo = (facet as TableFacet).frozenGroupInfo;
    let min = 0;
    const frozenRowRange = frozenInfo?.frozenRow?.range;
    if (frozenRowRange) {
      min = frozenRowRange[1] + 1;
    }
    if (yIndex < min) {
      return null;
    }

    let max = facet.getCellRange().end;
    const frozenTrailingRowRange = frozenInfo?.frozenTrailingRow?.range;
    if (frozenTrailingRowRange) {
      max = frozenTrailingRowRange[0] - 1;
    }
    if (yIndex > max) {
      return null;
    }

    return yIndex;
  };

  public validateXIndex = (xIndex: number) => {
    const { facet } = this.spreadsheet;
    const frozenInfo = (facet as TableFacet).frozenGroupInfo;

    let min = 0;
    const frozenColRange = frozenInfo?.frozenCol?.range;
    if (frozenColRange) {
      min = frozenColRange[1] + 1;
    }
    if (xIndex < min) {
      return null;
    }

    let max = facet.layoutResult.colLeafNodes.length - 1;
    const frozenTrailingColRange = frozenInfo?.frozenTrailingCol?.range;
    if (frozenTrailingColRange) {
      max = frozenTrailingColRange[0] - 1;
    }
    if (xIndex > max) {
      return null;
    }
    return xIndex;
  };

  public adjustNextColIndexWithFrozen = (
    colIndex: number,
    dir: ScrollDirection,
  ) => {
    const { facet, dataSet, options } = this.spreadsheet;
    const dataLength = dataSet.getDisplayDataSet().length;
    const colLength = facet.layoutResult.colLeafNodes.length;

    const { frozenTrailingColCount, frozenColCount } = getValidFrozenOptions(
      options,
      colLength,
      dataLength,
    );
    const panelIndexes = (facet as TableFacet).panelScrollGroupIndexes;
    if (
      frozenTrailingColCount > 0 &&
      dir === ScrollDirection.SCROLL_DOWN &&
      isFrozenTrailingCol(colIndex, frozenTrailingColCount, colLength)
    ) {
      return panelIndexes[1];
    }

    if (
      frozenColCount > 0 &&
      dir === ScrollDirection.SCROLL_UP &&
      isFrozenCol(colIndex, frozenColCount)
    ) {
      return panelIndexes[0];
    }
    return colIndex;
  };

  public adjustNextRowIndexWithFrozen = (
    rowIndex: number,
    dir: ScrollDirection,
  ) => {
    const { facet, dataSet, options } = this.spreadsheet;
    const dataLength = dataSet.getDisplayDataSet().length;
    const colLength = facet.layoutResult.colLeafNodes.length;
    const cellRange = facet.getCellRange();
    const { frozenTrailingRowCount, frozenRowCount } = getValidFrozenOptions(
      options,
      colLength,
      dataLength,
    );
    const panelIndexes = (facet as TableFacet).panelScrollGroupIndexes;
    if (
      frozenTrailingRowCount > 0 &&
      dir === ScrollDirection.SCROLL_DOWN &&
      isFrozenTrailingRow(rowIndex, cellRange.end, frozenTrailingRowCount)
    ) {
      return panelIndexes[3];
    }

    if (
      frozenRowCount > 0 &&
      dir === ScrollDirection.SCROLL_UP &&
      isFrozenRow(rowIndex, cellRange.start, frozenRowCount)
    ) {
      return panelIndexes[2];
    }
    return rowIndex;
  };

  public getWillScrollRowIndexDiff = (dir: ScrollDirection): number => {
    return dir === ScrollDirection.SCROLL_DOWN
      ? ScrollDirectionRowIndexDiff.SCROLL_DOWN
      : ScrollDirectionRowIndexDiff.SCROLL_UP;
  };

  public getDefaultWillScrollToRowIndex = (dir: ScrollDirection) => {
    const rowIndex = this.adjustNextRowIndexWithFrozen(
      this.endBrushPoint.rowIndex,
      dir,
    );
    const nextRowIndex = rowIndex + this.getWillScrollRowIndexDiff(dir);
    return this.validateYIndex(nextRowIndex);
  };

  protected getWillScrollToRowIndex = (dir: ScrollDirection): number => {
    return this.getDefaultWillScrollToRowIndex(dir);
  };

  private getNextScrollDelta = (config: BrushAutoScrollConfig) => {
    const { scrollX, scrollY } = this.spreadsheet.facet.getScrollOffset();

    let x = 0;
    let y = 0;

    if (config.y.scroll) {
      const dir =
        config.y.value > 0
          ? ScrollDirection.SCROLL_DOWN
          : ScrollDirection.SCROLL_UP;
      const willScrollToRowIndex = this.getWillScrollToRowIndex(dir);
      const scrollOffsetY =
        getScrollOffsetForRow(willScrollToRowIndex, dir, this.spreadsheet) -
        scrollY;
      const isInvalidScroll =
        isNil(willScrollToRowIndex) ||
        isNil(scrollOffsetY) ||
        Number.isNaN(scrollOffsetY);
      y = isInvalidScroll ? 0 : scrollOffsetY;
    }

    if (config.x.scroll) {
      const dir =
        config.x.value > 0
          ? ScrollDirection.SCROLL_DOWN
          : ScrollDirection.SCROLL_UP;
      const colIndex = this.adjustNextColIndexWithFrozen(
        this.endBrushPoint.colIndex,
        dir,
      );
      const nextIndex = this.validateXIndex(
        colIndex + (config.x.value > 0 ? 1 : -1),
      );
      x = isNil(nextIndex)
        ? 0
        : getScrollOffsetForCol(nextIndex, dir, this.spreadsheet) - scrollX;
    }

    return {
      x,
      y,
    };
  };

  private onScrollAnimationComplete = () => {
    this.scrollAnimationComplete = true;
    if (
      this.brushSelectionStage !== InteractionBrushSelectionStage.UN_DRAGGED
    ) {
      this.renderPrepareSelected(this.endBrushPoint);
    }
  };

  private autoScroll = (isRowHeader = false) => {
    if (
      this.brushSelectionStage === InteractionBrushSelectionStage.UN_DRAGGED ||
      !this.scrollAnimationComplete
    ) {
      return;
    }
    const config = this.autoScrollConfig;
    const scrollOffset = this.spreadsheet.facet.getScrollOffset();
    const key: keyof OffsetConfig = isRowHeader
      ? 'rowHeaderOffsetX'
      : 'offsetX';

    const offsetCfg: OffsetConfig = {
      rowHeaderOffsetX: {
        value: scrollOffset.rowHeaderScrollX,
        animate: true,
      },
      offsetX: {
        value: scrollOffset.scrollX,
        animate: true,
      },
      offsetY: {
        value: scrollOffset.scrollY,
        animate: true,
      },
    };

    const { x: deltaX, y: deltaY } = this.getNextScrollDelta(config);

    if (deltaY === 0 && deltaX === 0) {
      this.clearAutoScroll();
      return;
    }

    if (config.y.scroll) {
      offsetCfg.offsetY.value += deltaY;
    }

    if (config.x.scroll) {
      const offset = offsetCfg[key];
      offset.value += deltaX;
      if (offset.value < 0) {
        offset.value = 0;
      }
    }

    this.scrollAnimationComplete = false;
    // x 轴滚动速度慢
    const ratio = config.x.scroll ? 1 : 3;
    const duration = Math.max(
      16,
      300 - this.mouseMoveDistanceFromCanvas * ratio,
    );
    this.spreadsheet.facet.scrollWithAnimation(
      offsetCfg,
      duration,
      this.onScrollAnimationComplete,
    );
  };

  protected handleScroll = throttle(
    (x: number, y: number, isRowHeader = false) => {
      if (
        this.brushSelectionStage === InteractionBrushSelectionStage.UN_DRAGGED
      ) {
        return;
      }

      const {
        x: { value: newX, needScroll: needScrollForX },
        y: { value: newY, needScroll: needScrollForY },
      } = this.formatBrushPointForScroll({ x, y }, isRowHeader);

      const config = this.autoScrollConfig;
      if (needScrollForY) {
        config.y.value = y;
        config.y.scroll = true;
      }
      if (needScrollForX) {
        config.x.value = x;
        config.x.scroll = true;
      }

      this.setMoveDistanceFromCanvas({ x, y }, needScrollForX, needScrollForY);
      this.renderPrepareSelected({
        x: newX,
        y: newY,
      });

      if (needScrollForY || needScrollForX) {
        this.clearAutoScroll();
        this.autoScroll(isRowHeader);
        this.autoScrollIntervalId = setInterval(() => {
          this.autoScroll(isRowHeader);
        }, 16);
      }
    },
    30,
  );

  protected clearAutoScroll = () => {
    if (this.autoScrollIntervalId) {
      clearInterval(this.autoScrollIntervalId);
      this.autoScrollIntervalId = null;
      this.resetScrollDelta();
    }
  };

  protected resetDrag() {
    this.hidePrepareSelectMaskShape();
    this.setBrushSelectionStage(InteractionBrushSelectionStage.UN_DRAGGED);
  }

  public isValidBrushSelection() {
    const { start, end } = this.getBrushRange();
    const isMovedEnoughDistance =
      end.x - start.x > this.brushSelectionMinimumMoveDistance ||
      end.y - start.y > this.brushSelectionMinimumMoveDistance;

    return isMovedEnoughDistance;
  }

  protected setDisplayedCells() {
    this.displayedCells =
      this.spreadsheet.interaction.getPanelGroupAllDataCells();
  }

  protected updatePrepareSelectMask() {
    const brushRange = this.getBrushRange();
    const { x, y } = this.getPrepareSelectMaskPosition(brushRange);

    this.prepareSelectMaskShape.attr({
      x,
      y,
      width: brushRange.width,
      height: brushRange.height,
    });
    this.prepareSelectMaskShape.show();
  }

  public hidePrepareSelectMaskShape() {
    this.prepareSelectMaskShape?.hide();
  }

  protected resetScrollDelta() {
    this.autoScrollConfig = cloneDeep(BRUSH_AUTO_SCROLL_INITIAL_CONFIG);
  }

  protected getBrushPoint(event: CanvasEvent): BrushPoint {
    const { scrollY, scrollX } = this.spreadsheet.facet.getScrollOffset();
    const point: Point = {
      x: event?.x,
      y: event?.y,
    };
    const cell = this.spreadsheet.getCell(event.target);
    const { colIndex, rowIndex } = cell.getMeta();

    return {
      ...point,
      rowIndex,
      colIndex,
      scrollY,
      scrollX,
    };
  }

  // 四个刷选方向: 左 => 右, 右 => 左, 上 => 下, 下 => 上, 将最终结果进行重新排序, 获取真实的 row, col index
  public getBrushRange(): BrushRange {
    const { scrollX, scrollY } = this.spreadsheet.facet.getScrollOffset();
    const minRowIndex = Math.min(
      this.startBrushPoint.rowIndex,
      this.endBrushPoint?.rowIndex,
    );
    const maxRowIndex = Math.max(
      this.startBrushPoint.rowIndex,
      this.endBrushPoint?.rowIndex,
    );
    const minColIndex = Math.min(
      this.startBrushPoint.colIndex,
      this.endBrushPoint?.colIndex,
    );
    const maxColIndex = Math.max(
      this.startBrushPoint.colIndex,
      this.endBrushPoint?.colIndex,
    );
    const startXInView =
      this.startBrushPoint.x + this.startBrushPoint.scrollX - scrollX;
    const startYInView =
      this.startBrushPoint.y + this.startBrushPoint.scrollY - scrollY;
    // startBrushPoint 和 endBrushPoint 加上当前 offset
    const minX = Math.min(startXInView, this.endBrushPoint?.x);
    const maxX = Math.max(startXInView, this.endBrushPoint?.x);
    const minY = Math.min(startYInView, this.endBrushPoint?.y);
    const maxY = Math.max(startYInView, this.endBrushPoint?.y);

    // x, y: 表示从整个表格（包含表头）从左上角作为 (0, 0) 的画布区域。
    // 这个 x, y 只有在绘制虚拟画布 和 是否有效移动时有效。
    return {
      start: {
        rowIndex: minRowIndex,
        colIndex: minColIndex,
        x: minX,
        y: minY,
      },
      end: {
        rowIndex: maxRowIndex,
        colIndex: maxColIndex,
        x: maxX,
        y: maxY,
      },
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  // 获取对角线的两个坐标, 得到对应矩阵并且有数据的单元格
  protected getBrushRangeCells(): S2CellType[] {
    this.setDisplayedCells();
    return this.displayedCells.filter((cell) => {
      const meta = cell.getMeta();
      return this.isInBrushRange(meta);
    });
  }

  protected onUpdateCells: OnUpdateCells = (_, defaultOnUpdateCells) => {
    return defaultOnUpdateCells();
  };

  // 刷选过程中高亮的cell
  private showPrepareSelectedCells = () => {
    this.brushRangeCells = this.getBrushRangeCells();
    this.spreadsheet.interaction.changeState({
      cells: map(this.brushRangeCells, (item) => getCellMeta(item)),
      stateName: InteractionStateName.PREPARE_SELECT,
      // 刷选首先会经过 hover => mousedown => mousemove, hover时会将当前行全部高亮 (row cell + data cell)
      // 如果是有效刷选, 更新时会重新渲染, hover 高亮的格子 会正常重置
      // 如果是无效刷选(全部都是没数据的格子), brushRangeDataCells = [], 更新时会跳过, 需要强制重置 hover 高亮
      force: true,
      onUpdateCells: this.onUpdateCells,
    });
  };

  protected mouseDown(event: CanvasEvent) {
    event?.preventDefault?.();
    if (this.spreadsheet.interaction.hasIntercepts([InterceptType.CLICK])) {
      return;
    }
    this.setBrushSelectionStage(InteractionBrushSelectionStage.CLICK);
    this.initPrepareSelectMaskShape();
    this.setDisplayedCells();
    this.startBrushPoint = this.getBrushPoint(event);
  }

  protected addBrushIntercepts() {
    this.spreadsheet.interaction.addIntercepts([InterceptType.BRUSH_SELECTION]);
  }

  protected bindMouseUp(enableScroll = false) {
    // 使用全局的 mouseup, 而不是 canvas 的 mouse up 防止刷选过程中移出表格区域时无法响应事件
    this.spreadsheet.on(S2Event.GLOBAL_MOUSE_UP, (event) => {
      if (this.brushSelectionStage !== InteractionBrushSelectionStage.DRAGGED) {
        this.resetDrag();
        return;
      }

      if (enableScroll) {
        this.clearAutoScroll();
      }

      if (this.isValidBrushSelection()) {
        this.addBrushIntercepts();
        this.updateSelectedCells();

        const tooltipData = getCellsTooltipData(this.spreadsheet);
        this.spreadsheet.showTooltipWithInfo(event, tooltipData);
      }

      if (
        this.spreadsheet.interaction.getCurrentStateName() ===
        InteractionStateName.PREPARE_SELECT
      ) {
        this.spreadsheet.interaction.reset();
      }

      this.resetDrag();
    });

    // 刷选过程中右键弹出系统菜单时, 应该重置刷选, 防止系统菜单关闭后 mouse up 未相应依然是刷选状态
    this.spreadsheet.on(S2Event.GLOBAL_CONTEXT_MENU, () => {
      if (
        this.brushSelectionStage === InteractionBrushSelectionStage.UN_DRAGGED
      ) {
        return;
      }
      this.spreadsheet.interaction.removeIntercepts([InterceptType.HOVER]);
      this.resetDrag();
    });
  }

  protected renderPrepareSelected = (point: Point) => {
    const { x, y } = point;
    const target = this.spreadsheet.container.getShape(x, y);
    const cell = this.spreadsheet.getCell(target);

    // 只有行头，列头，单元格可以刷选
    const isBrushCellType =
      cell instanceof DataCell ||
      cell instanceof RowCell ||
      cell instanceof ColCell;

    if (!cell || !isBrushCellType) {
      return;
    }

    const { rowIndex, colIndex } = cell.getMeta();

    this.endBrushPoint = {
      x,
      y,
      rowIndex,
      colIndex,
    };

    const { interaction } = this.spreadsheet;
    interaction.addIntercepts([InterceptType.HOVER]);
    interaction.clearStyleIndependent();
    if (this.isValidBrushSelection()) {
      this.showPrepareSelectedCells();
      this.updatePrepareSelectMask();
    }
  };

  public autoBrushScroll(point: Point, isRowHeader = false) {
    this.clearAutoScroll();

    if (!this.isPointInCanvas(point)) {
      const deltaX = point?.x - this.endBrushPoint?.x;
      const deltaY = point?.y - this.endBrushPoint?.y;
      this.handleScroll(deltaX, deltaY, isRowHeader);

      return true;
    }

    return false;
  }

  public emitBrushSelectionEvent(
    event: S2Event,
    scrollBrushRangeCells: S2CellType[],
  ) {
    this.spreadsheet.emit(event, scrollBrushRangeCells);
    this.spreadsheet.emit(S2Event.GLOBAL_SELECTED, scrollBrushRangeCells);

    // 未刷选到有效单元格, 允许 hover
    if (isEmpty(scrollBrushRangeCells)) {
      this.spreadsheet.interaction.removeIntercepts([InterceptType.HOVER]);
    }
  }

  public getVisibleBrushRangeCells(nodeId: string) {
    return this.brushRangeCells.find((cell) => {
      const visibleCellMeta = cell.getMeta();
      return visibleCellMeta?.id === nodeId;
    });
  }

  // 需要查看继承他的父类是如何定义的
  protected isInBrushRange(meta: ViewMeta | Node): boolean {
    return false;
  }

  protected bindMouseDown() {}

  protected bindMouseMove() {}

  protected updateSelectedCells() {}

  protected getPrepareSelectMaskPosition(brushRange: BrushRange): Point {
    return {
      x: brushRange.start.x,
      y: brushRange.start.y,
    };
  }
}
