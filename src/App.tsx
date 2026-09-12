import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  Activity,
  AlertTriangle,
  BellRing,
  Clock3,
  Download,
  MapPin,
  PackageCheck,
  PackageX,
  Pause,
  Play,
  Plus,
  Radar,
  RefreshCw,
  Settings2,
  ShoppingBag,
  Smartphone,
  SquareTerminal,
  Trash2,
  Volume2,
  X,
} from "lucide-react";

import { describeUpdateProgress, updatePercent } from "@/lib/updateStatus";
import { Combobox } from "@/components/Combobox";
import { MultiCombobox } from "@/components/MultiCombobox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import {
  changeLocale,
  connect,
  dismissUpdate,
  installUpdate,
  openReleasePage,
  openTargetProduct,
  refreshProducts,
  saveSettings,
  setCategory,
  setIntervalSeconds,
  setTargets,
  startWatching,
  stopWatching,
  testNotify,
  watcherStore,
} from "@/lib/store";
import {
  type Availability,
  type PickupDetails,
  type Category,
  type OpenOnHit,
  describeAdvice,
  formatTime,
  isUntrusted,
  type StatusTone,
  type Target,
  targetKey,
} from "@/lib/types";

import { describeMonitorStatus } from "@/lib/monitorLog";
import { compareNewestProducts, sortMonitorsNewestFirst } from "@/lib/productOrder";

const TONE_CLASS: Record<StatusTone, string> = {
  inStock: "bg-in-stock/12 text-in-stock border-in-stock/25",
  outOfStock: "bg-out-of-stock/12 text-out-of-stock border-out-of-stock/30",
  presale: "bg-presale/12 text-presale border-presale/30",
  comingSoon: "bg-coming-soon/12 text-coming-soon border-coming-soon/30",
  pickupUnsupported: "bg-pickup-unsupported/12 text-pickup-unsupported border-pickup-unsupported/30",
  notForSale: "bg-not-for-sale/12 text-not-for-sale border-not-for-sale/30",
  unknown: "bg-unknown/12 text-unknown border-unknown/30",
  pending: "bg-transparent text-muted-foreground/70 border-border border-dashed",
};

const TONE_DOT: Record<StatusTone, string> = {
  inStock: "bg-in-stock shadow-[0_0_10px_var(--in-stock)]",
  outOfStock: "bg-out-of-stock",
  presale: "bg-presale",
  comingSoon: "bg-coming-soon",
  pickupUnsupported: "bg-pickup-unsupported",
  notForSale: "bg-not-for-sale",
  unknown: "bg-unknown",
  pending: "bg-muted-foreground/50",
};

function StatusBadge({ availability, pickupDetails }: { availability: Availability; pickupDetails?: PickupDetails }) {
  const { label, tone, detail } = describeMonitorStatus({ availability, pickupDetails });
  const badge = (
    <Badge
      variant="outline"
      className={`h-8 min-w-0 justify-center gap-2 px-2.5 font-medium md:h-7 md:min-w-20 ${TONE_CLASS[tone]}`}
    >
      <span className={`size-1.5 rounded-full ${TONE_DOT[tone]}`} aria-hidden="true" />
      {label}
    </Badge>
  );
  if (!detail) return badge;
  return (
    // items-stretch（默认）而不是 items-start：后者会把状态明细改成按 max-content 定宽，
    // 超长中文不换行直接撑出 600+px，把卡片拖出横向滚动条。
    <div className="flex flex-col gap-1.5 md:block">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help">{badge}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-90">{detail}</TooltipContent>
      </Tooltip>
      {/* Tooltip 只在 hover/focus 时打开，触屏永远拿不到；窄屏把明细直接铺出来。 */}
      <span className="text-xs leading-5 text-muted-foreground md:hidden">{detail}</span>
    </div>
  );
}

export default function App() {
  const ui = useSyncExternalStore(watcherStore.subscribe, watcherStore.getSnapshot);
  const [clockMs, setClockMs] = useState(() => Date.now());

  useEffect(() => {
    void connect();
  }, []);

  useEffect(() => {
    if (!ui.running) return;
    setClockMs(Date.now());
    const timer = window.setInterval(() => setClockMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [ui.running]);

  const [storeNumbers, setStoreNumbers] = useState<string[]>([]);
  const [partNumbers, setPartNumbers] = useState<string[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [barkDraft, setBarkDraft] = useState<string | null>(null);
  const [intervalDraft, setIntervalDraft] = useState<number | null>(null);

  const barkValue = barkDraft ?? ui.settings.barkUrl;
  const intervalValue = intervalDraft ?? ui.settings.intervalSeconds;
  const latestCheckedMs = Math.max(0, ...ui.rows.map((row) => row.lastCheckedMs ?? 0));
  const secondsUntilNextCheck = latestCheckedMs
    ? Math.max(0, Math.ceil((latestCheckedMs + ui.settings.intervalSeconds * 1_000 - clockMs) / 1_000))
    : null;
  const runningLabel =
    secondsUntilNextCheck === null || secondsUntilNextCheck === 0
      ? "正在查询"
      : `约 ${secondsUntilNextCheck} 秒后检查`;

  const storeOptions = useMemo(
    () => ui.stores.map((store) => ({ value: store.number, label: store.title })),
    [ui.stores],
  );
  const productOptions = useMemo(
    () =>
      ui.products
        .filter((product) => product.category === ui.category)
        .sort(compareNewestProducts)
        .map((product) => ({ value: product.partNumber, label: product.title })),
    [ui.products, ui.category],
  );

  const sortedRows = useMemo(() => sortMonitorsNewestFirst(ui.rows), [ui.rows]);

  const targets = useMemo(() => ui.rows.map((row) => row.target), [ui.rows]);

  useEffect(() => {
    const valid = new Set(storeOptions.map((option) => option.value));
    setStoreNumbers((previous) => {
      const next = previous.filter((value) => valid.has(value));
      return next.length === previous.length ? previous : next;
    });
  }, [storeOptions]);

  useEffect(() => {
    const valid = new Set(productOptions.map((option) => option.value));
    setPartNumbers((previous) => {
      const next = previous.filter((value) => valid.has(value));
      return next.length === previous.length ? previous : next;
    });
  }, [productOptions]);

  const summary = useMemo(() => {
    let inStock = 0;
    let outOfStock = 0;
    let untrusted = 0;
    for (const row of ui.rows) {
      if (row.availability.kind === "in_stock") inStock += 1;
      else if (row.availability.kind === "out_of_stock") outOfStock += 1;
      if (isUntrusted(row.availability)) untrusted += 1;
    }
    return { inStock, outOfStock, untrusted };
  }, [ui.rows]);

  const pendingTargets = useMemo(() => {
    const existing = new Set(targets.map(targetKey));
    const stores = new Map(ui.stores.map((store) => [store.number, store]));
    const products = new Map(ui.products.map((product) => [product.partNumber, product]));
    const pending: Target[] = [];

    for (const storeNumber of storeNumbers) {
      const store = stores.get(storeNumber);
      if (!store) continue;
      for (const partNumber of partNumbers) {
        const product = products.get(partNumber);
        if (!product || product.category !== ui.category) continue;
        const target: Target = {
          locale: ui.settings.locale,
          storeNumber: store.number,
          storeTitle: store.title,
          partNumber: product.partNumber,
          productName: product.title,
        };
        if (!existing.has(targetKey(target))) {
          existing.add(targetKey(target));
          pending.push(target);
        }
      }
    }
    return pending;
  }, [partNumbers, storeNumbers, targets, ui.category, ui.products, ui.settings.locale, ui.stores]);

  const hasCompleteSelection = storeNumbers.length > 0 && partNumbers.length > 0;
  const canAdd = pendingTargets.length > 0 && !isAdding;
  const duplicateCount = storeNumbers.length * partNumbers.length - pendingTargets.length;

  async function onAdd() {
    if (!canAdd) return;
    setIsAdding(true);
    try {
      if (await setTargets([...targets, ...pendingTargets])) setPartNumbers([]);
    } finally {
      setIsAdding(false);
    }
  }

  async function onRemove(target: Target) {
    await setTargets(targets.filter((item) => targetKey(item) !== targetKey(target)));
  }

  return (
    <TooltipProvider delayDuration={180}>
      <div className="app-canvas min-h-screen text-foreground">
        <main className="mx-auto flex min-h-dvh w-full min-w-0 max-w-[1180px] flex-col gap-3 px-4 py-4 sm:gap-4 sm:px-5 sm:py-5 lg:h-screen lg:overflow-hidden">
          {/* 窄屏两行（标题 / 状态+操作），≥640px 回到单行左右布局：390px 下右侧组
              实测占 258px，单行会把左标题压到 32px，只剩「果…」。 */}
          <header className="surface-panel flex shrink-0 flex-col items-stretch gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-5 sm:px-5 sm:py-4">
            <div className="flex min-w-0 items-center gap-3.5">
              <div className="brand-mark" aria-hidden="true">
                <Radar className="size-5" strokeWidth={1.8} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="whitespace-nowrap text-lg font-semibold tracking-[-0.02em]">
                    果到雷达
                  </h1>
                  <Badge variant="outline" className="hidden border-primary/20 bg-primary/8 text-primary sm:inline-flex">
                    LIVE
                  </Badge>
                </div>
                <p className="mt-0.5 truncate text-sm text-muted-foreground">
                  Apple 直营店取货库存监控
                </p>
              </div>
            </div>

            <div className="flex w-full items-center justify-between gap-2.5 sm:w-auto sm:justify-normal">
              <div className="status-pill min-w-0 flex-1 sm:flex-none" role="status" aria-live="polite">
                <span
                  className={`size-2 rounded-full ${ui.running ? "bg-in-stock shadow-[0_0_12px_var(--in-stock)]" : "bg-muted-foreground/55"}`}
                  aria-hidden="true"
                />
                <span className="text-xs text-muted-foreground max-sm:sr-only">监控状态</span>
                <span className="text-sm font-medium tabular-nums">{ui.running ? runningLabel : "已暂停"}</span>
              </div>
              {ui.running ? (
                <Button
                  variant="secondary"
                  className="h-11 shrink-0 rounded-xl px-4 sm:h-10"
                  onClick={() => void stopWatching()}
                >
                  <Pause aria-hidden="true" /> 暂停
                </Button>
              ) : (
                <Button
                  className="h-11 shrink-0 rounded-xl px-4 shadow-[0_8px_24px_-12px_var(--primary)] sm:h-10"
                  onClick={() => void startWatching()}
                  disabled={ui.rows.length === 0}
                >
                  <Play aria-hidden="true" /> 开始监控
                </Button>
              )}
            </div>
          </header>

          {ui.trouble !== null && (
            <Alert variant="destructive" className="shrink-0 rounded-2xl border-destructive/25 bg-destructive/8 px-4 py-3">
              <AlertTriangle aria-hidden="true" />
              <AlertTitle>监控结果暂不可信</AlertTitle>
              <AlertDescription>
                {ui.trouble.reason}
                <span>列表状态可能不代表真实库存，请先排查后再继续等待。</span>
                {ui.trouble.advice !== null && (
                  <span className="font-medium">{describeAdvice(ui.trouble.advice)}</span>
                )}
              </AlertDescription>
            </Alert>
          )}

          {ui.update !== null && (
            <Alert className="shrink-0 rounded-2xl border-primary/20 bg-primary/8 px-4 py-3">
              <Download aria-hidden="true" />
              <AlertTitle>{ui.updateInstalled ? "更新已安装" : "发现新版本"} {ui.update.version}</AlertTitle>
              <AlertDescription>
                <span>{ui.updateInstalled ? "请退出并重新打开应用，新版本才会生效。" : `当前版本 ${ui.update.currentVersion}，安装后需重启应用。`}</span>
                {ui.updateProgress !== null && (
                  <div className="w-full space-y-1" role="status" aria-live="polite">
                    <span>{describeUpdateProgress(ui.updateProgress)}</span>
                    {ui.updateProgress.phase === "downloading" && (
                      <progress className="block h-2 w-full max-w-sm accent-primary" aria-label="更新下载进度"
                        max={100} value={updatePercent(ui.updateProgress)} />
                    )}
                  </div>
                )}
                {ui.updateError !== null && <p className="break-words text-destructive" role="alert">{ui.updateError}</p>}
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <Button className="h-10 sm:h-8" size="sm" disabled={ui.installing || ui.updateInstalled} onClick={() => void installUpdate()}>
                    {ui.updateInstalled ? "已安装" : ui.installing ? "正在更新…" : ui.updateError ? "重试" : "下载并安装"}
                  </Button>
                  {ui.updateError !== null && (
                    <Button className="h-10 sm:h-8" size="sm" variant="outline" onClick={() => void openReleasePage()}>下载安装包</Button>
                  )}
                  <Button className="h-10 sm:h-8" size="sm" variant="ghost" disabled={ui.installing} onClick={dismissUpdate}>
                    <X aria-hidden="true" /> 稍后
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {/* grid-cols-1 是必须的：<980px 时若没有显式列定义，隐式 auto 轨道的最小尺寸
              等于子项 min-content（表格链路实测 684px），轨道比容器宽就向右溢出。
              grid-cols-1 展开为 minmax(0,1fr)，把轨道最小值钉成 0。 */}
          <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-4 min-[980px]:grid-cols-[minmax(0,1.65fr)_20rem]">
            <div className="flex min-h-0 min-w-0 flex-col gap-4">
              <section className="surface-panel min-w-0 shrink-0 p-3 sm:p-4" aria-labelledby="create-monitor-title">
                <div className="mb-4 flex min-w-0 items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="eyebrow">
                      <Plus className="size-3.5" aria-hidden="true" /> 新建监控
                    </div>
                    <h2 id="create-monitor-title" className="mt-1 text-base font-semibold tracking-tight">
                      选择想要追踪的门店与型号
                    </h2>
                  </div>
                  {hasCompleteSelection && (
                    <Badge className="shrink-0 border-primary/20 bg-primary/10 text-primary" variant="outline">
                      {storeNumbers.length} × {partNumbers.length}
                    </Badge>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[0.9fr_0.9fr_1.3fr_2fr]">
                  <div className="field-group">
                    <Label className="control-label">
                      <MapPin className="size-3.5" aria-hidden="true" /> 地区
                    </Label>
                    <Combobox
                      className="control-surface w-full"
                      options={ui.regions.map((region) => ({ value: region.locale, label: region.title }))}
                      value={ui.settings.locale}
                      onChange={(locale) => {
                        setStoreNumbers([]);
                        setPartNumbers([]);
                        void changeLocale(locale);
                      }}
                      placeholder="选择地区"
                      searchPlaceholder="搜索地区…"
                      emptyText="没有匹配的地区"
                      disabled={isAdding}
                    />
                  </div>

                  <div className="field-group">
                    <Label className="control-label">
                      <Smartphone className="size-3.5" aria-hidden="true" /> 品类
                    </Label>
                    <Combobox
                      className="control-surface w-full"
                      options={ui.categories.map((category) => ({ value: category.value, label: category.title }))}
                      value={ui.category}
                      onChange={(value) => {
                        setPartNumbers([]);
                        setCategory(value as Category);
                      }}
                      placeholder="选择品类"
                      searchPlaceholder="搜索品类…"
                      emptyText="没有匹配的品类"
                      disabled={isAdding || ui.categories.length === 0}
                    />
                  </div>

                  <div className="field-group">
                    <Label className="control-label">
                      <MapPin className="size-3.5" aria-hidden="true" /> 门店
                      <span className="font-normal text-muted-foreground">可多选</span>
                    </Label>
                    <MultiCombobox
                      key={`stores-${ui.settings.locale}`}
                      className="control-surface w-full"
                      options={storeOptions}
                      values={storeNumbers}
                      onChange={setStoreNumbers}
                      placeholder="选择自提门店"
                      searchPlaceholder="搜索门店…"
                      emptyText="没有匹配的门店"
                      selectionUnit="家门店"
                      disabled={isAdding || storeOptions.length === 0}
                    />
                  </div>

                  <div className="field-group">
                    <Label className="control-label">
                      <PackageCheck className="size-3.5" aria-hidden="true" /> 型号
                      <span className="font-normal text-muted-foreground">可多选</span>
                    </Label>
                    <MultiCombobox
                      key={`products-${ui.settings.locale}-${ui.category}`}
                      className="control-surface w-full"
                      options={productOptions}
                      values={partNumbers}
                      onChange={setPartNumbers}
                      placeholder="选择型号"
                      searchPlaceholder="搜索型号…"
                      emptyText="没有匹配的型号"
                      selectionUnit="个型号"
                      disabled={isAdding || productOptions.length === 0}
                    />
                  </div>
                </div>

                <div className="mt-3 flex min-w-0 flex-wrap items-center justify-between gap-3 border-t border-border/55 pt-3">
                  <p className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground" role="status">
                    {hasCompleteSelection
                      ? `将新增 ${pendingTargets.length} 条监控${duplicateCount > 0 ? `，跳过 ${duplicateCount} 条已有组合` : ""}`
                      : "选择门店和型号后，系统会按全部组合创建监控。"}
                  </p>
                  <div className="flex w-full items-center gap-2 sm:w-auto">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon-lg"
                          className="h-11 w-auto shrink-0 gap-1.5 rounded-xl border-border/70 bg-background/40 px-3 sm:h-10 sm:w-10 sm:px-0"
                          aria-label="从 Apple 官网更新当前品类的型号列表"
                          disabled={ui.refreshing}
                          onClick={() => void refreshProducts()}
                        >
                          <RefreshCw className={ui.refreshing ? "animate-spin" : undefined} />
                          {/* 这个按钮原本只靠 Tooltip 表意，触屏看不到 Tooltip，窄屏直接给文字。 */}
                          <span className="text-xs sm:hidden">更新型号</span>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>从 Apple 官网更新当前品类的型号列表</TooltipContent>
                    </Tooltip>
                    <Button
                      className="h-11 min-w-0 flex-1 rounded-xl px-4 sm:h-10 sm:min-w-28 sm:flex-none"
                      onClick={() => void onAdd()}
                      disabled={!canAdd}
                    >
                      <Plus aria-hidden="true" />
                      {isAdding
                        ? "添加中…"
                        : canAdd
                          ? `添加 ${pendingTargets.length} 项`
                          : hasCompleteSelection
                            ? "已在列表中"
                            : "添加监控"}
                    </Button>
                  </div>
                </div>
              </section>

              <section className="surface-panel flex min-h-[280px] min-w-0 flex-1 flex-col overflow-hidden lg:min-h-0" aria-labelledby="monitor-list-title">
                <div className="flex min-w-0 shrink-0 items-center justify-between border-b border-border/60 px-4 py-3.5">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="section-icon" aria-hidden="true">
                      <Activity className="size-4" />
                    </div>
                    <div className="min-w-0">
                      <h2 id="monitor-list-title" className="text-sm font-semibold">监控列表</h2>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">新款优先 · 库存变化实时更新</p>
                    </div>
                  </div>
                  <span className="shrink-0 rounded-full border border-border/60 bg-background/40 px-2.5 py-1 text-xs tabular-nums text-muted-foreground">
                    {ui.rows.length} 项
                  </span>
                </div>

                {/* 滚动容器交给 Table 自带的 table-container（它才是 thead 的最近滚动容器）：
                    原先外面套 ScrollArea，而 radix 的 viewport 是 overflow-x:hidden + 内层
                    display:table，既不可能横向滚动，也让表格自带的 overflow-x-auto 被架空，
                    连带 sticky 表头一直没生效。容器拿到高度后，横滚、纵滚、吸附三项一起成立。 */}
                <Table
                  containerClassName="min-h-0 flex-1 overflow-auto overscroll-contain"
                  className="block md:table md:min-w-[36rem]"
                >
                  <TableHeader className="sticky top-0 z-10 hidden bg-card/95 md:table-header-group">
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="w-28 px-4 text-xs text-muted-foreground">状态</TableHead>
                        <TableHead className="px-3 text-xs text-muted-foreground">门店</TableHead>
                        <TableHead className="px-3 text-xs text-muted-foreground">型号</TableHead>
                        <TableHead className="w-24 px-3 text-xs text-muted-foreground">最后检查</TableHead>
                        <TableHead className="w-14" />
                      </TableRow>
                    </TableHeader>
                    <TableBody className="block md:table-row-group">
                      {ui.rows.length === 0 ? (
                        <TableRow className="block hover:bg-transparent md:table-row">
                          <TableCell colSpan={5} className="block h-44 text-center md:table-cell">
                            <div className="mx-auto flex max-w-xs flex-col items-center">
                              <div className="mb-3 flex size-11 items-center justify-center rounded-2xl border border-border/60 bg-muted/35 text-muted-foreground">
                                <Radar className="size-5" aria-hidden="true" />
                              </div>
                              <p className="text-sm font-medium text-foreground">
                                {ui.ready ? "还没有监控项目" : "正在载入目录…"}
                              </p>
                              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                {ui.ready ? "从上方选择门店和型号，添加后即可开始监控。" : "正在连接本地监控引擎，请稍候。"}
                              </p>
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : (
                        sortedRows.map((row) => (
                          <TableRow key={targetKey(row.target)} className="group flex flex-col gap-1.5 px-4 py-3.5 hover:bg-muted/22 md:table-row md:h-14 md:gap-0 md:px-0 md:py-0">
                            <TableCell className="block px-0 py-0.5 md:table-cell md:px-4 md:py-0"><StatusBadge availability={row.availability} pickupDetails={row.pickupDetails} /></TableCell>
                            <TableCell className="block px-0 py-0.5 font-medium md:table-cell md:px-3 md:py-0">{row.target.storeTitle}</TableCell>
                            <TableCell className="block max-w-none px-0 py-0.5 break-words whitespace-normal text-muted-foreground md:table-cell md:max-w-[24rem] md:truncate md:px-3 md:py-0 md:whitespace-nowrap" title={row.target.productName}>
                              <button
                                className="text-left hover:text-primary hover:underline"
                                aria-label={`打开商品页：${row.target.productName}`}
                                onClick={() => void openTargetProduct(row.target)}
                              >
                                {row.target.productName}
                              </button>
                            </TableCell>
                            <TableCell className="block px-0 py-0.5 font-mono text-xs tabular-nums text-muted-foreground md:table-cell md:px-3 md:py-0">
                              <span className="font-sans md:hidden">最后检查 </span>
                              {formatTime(row.lastCheckedMs)}
                            </TableCell>
                            <TableCell className="block self-end px-0 pt-1.5 md:table-cell md:self-auto md:px-0 md:pt-0 md:pr-3">
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="h-11 w-11 text-muted-foreground opacity-100 active:bg-destructive/10 active:text-destructive md:h-8 md:w-8 md:opacity-60 md:hover:bg-destructive/10 md:hover:text-destructive md:group-hover:opacity-100"
                                aria-label="删除这条监控"
                                disabled={isAdding}
                                onClick={() => void onRemove(row.target)}
                              >
                                <Trash2 />
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
              </section>
            </div>

            <aside className="flex min-h-0 min-w-0 flex-col gap-4">
              <section className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="监控概览">
                <div className="metric-tile">
                  <Radar className="size-4 text-primary" aria-hidden="true" />
                  <span className="metric-value">{ui.rows.length}</span>
                  <span className="metric-label">监控</span>
                </div>
                <div className="metric-tile">
                  <PackageCheck className="size-4 text-in-stock" aria-hidden="true" />
                  <span className="metric-value text-in-stock">{summary.inStock}</span>
                  <span className="metric-label">有货</span>
                </div>
                <div className="metric-tile">
                  <PackageX className="size-4 text-muted-foreground" aria-hidden="true" />
                  <span className="metric-value">{summary.outOfStock}</span>
                  <span className="metric-label">不可取货</span>
                </div>
                <div className="metric-tile">
                  <AlertTriangle className={`size-4 ${summary.untrusted > 0 ? "text-unknown" : "text-muted-foreground"}`} aria-hidden="true" />
                  <span className={`metric-value ${summary.untrusted > 0 ? "text-unknown" : ""}`}>{summary.untrusted}</span>
                  <span className="metric-label">未确认</span>
                </div>
              </section>

              <section className="surface-panel min-w-0 shrink-0 p-3 sm:p-4" aria-labelledby="preferences-title">
                <div className="mb-4 flex items-center gap-3">
                  <div className="section-icon" aria-hidden="true"><Settings2 className="size-4" /></div>
                  <div>
                    <h2 id="preferences-title" className="text-sm font-semibold">监控设置</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">查询频率与提醒方式</p>
                  </div>
                </div>

                <div className="field-group">
                  <Label htmlFor="interval" className="control-label">
                    <Clock3 className="size-3.5" aria-hidden="true" /> 查询间隔
                  </Label>
                  <div className="relative">
                    <Input
                      id="interval"
                      type="number"
                      inputMode="numeric"
                      enterKeyHint="done"
                      min={5}
                      className="control-surface select-text pr-12 tabular-nums"
                      value={intervalValue}
                      onChange={(event) => setIntervalDraft(event.target.valueAsNumber)}
                      onBlur={() => {
                        const seconds = Number.isFinite(intervalValue) ? Math.round(intervalValue) : 30;
                        setIntervalDraft(null);
                        void setIntervalSeconds(seconds);
                      }}
                    />
                    <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">秒</span>
                  </div>
                </div>

                <div className="mt-3 field-group">
                  <Label htmlFor="bark" className="control-label">
                    <BellRing className="size-3.5" aria-hidden="true" /> Bark 推送
                  </Label>
                  <Input
                    id="bark"
                    className="control-surface select-text"
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="done"
                    placeholder="https://api.day.app/你的BarkKey"
                    value={barkValue}
                    onChange={(event) => setBarkDraft(event.target.value)}
                    onBlur={() => {
                      setBarkDraft(null);
                      void saveSettings({ barkUrl: barkValue.trim() });
                    }}
                  />
                </div>

                <div className="mt-4 space-y-1 rounded-xl border border-border/55 bg-background/30 p-1">
                  {/* 整行做 label，因为 Switch 本身只有 18×32，命中区远低于 44px。 */}
                  <label htmlFor="sound" className="setting-row cursor-pointer">
                    <span className="flex items-center gap-2 text-sm"><Volume2 className="size-4 text-muted-foreground" aria-hidden="true" />提示音</span>
                    <Switch
                      id="sound"
                      aria-label="提示音"
                      checked={ui.settings.soundEnabled}
                      onCheckedChange={(value) => void saveSettings({ soundEnabled: value })}
                    />
                  </label>
                  <div className="setting-row flex-wrap gap-2">
                    <Label htmlFor="open-on-hit" className="flex items-center gap-2 text-sm font-normal">
                      <ShoppingBag className="size-4 text-muted-foreground" aria-hidden="true" />到货后打开
                    </Label>
                    <Select
                      value={ui.settings.openOnHit}
                      onValueChange={(value) =>
                        void saveSettings({ openOnHit: value as OpenOnHit })
                      }
                    >
                      <SelectTrigger id="open-on-hit" className="h-11 w-auto min-w-0 flex-1 bg-background/45 sm:h-9 sm:w-[8.5rem] sm:flex-none" aria-label="到货后打开">
                        <SelectValue />
                      </SelectTrigger>
                      {/* position="popper" 是故意的：默认的 item-aligned 按选中项对齐、宽度跟触发器，
                          窄屏 + align="end" 时容易贴边甚至被视口裁掉；popper 模式下宽度不小于触发器
                          并参与碰壁翻转。桌面下拉的选中项对齐是有意设计，所以不改组件默认值。 */}
                      <SelectContent position="popper" align="end" sideOffset={4}>
                        <SelectItem value="none">不自动打开</SelectItem>
                        <SelectItem value="bag">购物袋</SelectItem>
                        <SelectItem value="product">商品详情</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <Button variant="outline" className="mt-3 h-11 w-full rounded-xl border-border/70 bg-background/30 sm:h-10" onClick={() => void testNotify()}>
                  <BellRing aria-hidden="true" /> 测试提醒与跳转
                </Button>
              </section>

              <section className="surface-panel flex min-h-[150px] flex-1 flex-col overflow-hidden" aria-labelledby="activity-log-title">
                <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <SquareTerminal className="size-4 text-muted-foreground" aria-hidden="true" />
                    <h2 id="activity-log-title" className="text-sm font-semibold">活动日志</h2>
                  </div>
                  <span className="text-[11px] tabular-nums text-muted-foreground">{ui.logs.length} 条</span>
                </div>
                <ScrollArea className="min-h-0 flex-1">
                  <pre className="p-3.5 font-mono text-[11px] leading-[1.65] wrap-anywhere whitespace-pre-wrap text-muted-foreground select-text">
                    {ui.logs.length === 0 ? "等待监控活动…" : ui.logs.join("\n")}
                  </pre>
                </ScrollArea>
              </section>
            </aside>
          </div>
        </main>
      </div>
    </TooltipProvider>
  );
}
