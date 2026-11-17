import { useMediaQuery } from "@astryxdesign/core/hooks";
import { VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { type ColumnWidth, Table, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { createContext, type ReactNode, useContext } from "react";
import { SELECTABLE } from "../selection";

export type DataColumn<T> = {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  width?: ColumnWidth;
};

// Below Astryx's sm breakpoint (640 px, DEFAULT_WIDTH_BREAKPOINTS) the table stacks: each row
// becomes a list item with its fields one per line. The phone width (390 px, REQUIREMENTS.md)
// stacks; laptop (1280 px) and wide (1920 px) get the table.
const STACKED = "(max-width: 639.98px)";

// A stacked row is one column as wide as the screen; a value that does not fit wraps there
// instead of running under the next field or off the screen (owner ruling for phones).
const StackedContext = createContext(false);
const WRAP_ANYWHERE = { ...SELECTABLE, overflowWrap: "anywhere" } as const;

/**
 * A settings table that spans the frame at desktop width and stacks at phone width, so no value
 * is cut off and nothing scrolls sideways (web/AGENTS.md, Phone width). The first column is the
 * row's label; `actions` sits at the row's end: the last column of the table, or below the
 * fields of a stacked row, so they never share a line with a long value.
 */
export function DataTable<T extends { id: string | number }>({
  rows,
  columns,
  actions,
  actionsHeader,
}: {
  rows: T[];
  columns: DataColumn<T>[];
  actions?: (row: T) => ReactNode;
  actionsHeader?: string;
}) {
  const stacked = useMediaQuery(STACKED);
  if (stacked) {
    const [first, ...rest] = columns;
    return (
      <StackedContext.Provider value={true}>
        <List>
          {rows.map((row) => (
            <ListItem
              key={row.id}
              itemKey={row.id}
              align="start"
              label={first?.render(row)}
              description={
                <VStack gap={1} hAlign="stretch">
                  {rest.map((c) => (
                    <VStack key={c.key} gap={0}>
                      <Text type="supporting" color="secondary">
                        {c.header}
                      </Text>
                      {c.render(row)}
                    </VStack>
                  ))}
                  {actions?.(row)}
                </VStack>
              }
            />
          ))}
        </List>
      </StackedContext.Provider>
    );
  }
  type Row = T & Record<string, unknown>;
  const tableColumns: TableColumn<Row>[] = columns.map((c) => ({
    key: c.key,
    header: c.header,
    width: c.width,
    renderCell: (row: Row) => c.render(row),
  }));
  if (actions) {
    tableColumns.push({
      key: "actions",
      header: actionsHeader ?? "",
      align: "end",
      renderCell: (row: Row) => actions(row),
    });
  }
  return (
    <Table<Row>
      data={rows as Row[]}
      columns={tableColumns}
      idKey={(row) => row.id}
      verticalAlign="top"
    />
  );
}

/** The loading state of a table: three rows at their final height. */
export function TableSkeleton() {
  return (
    <VStack gap={2} hAlign="stretch">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} height="var(--size-control-lg)" index={i} />
      ))}
    </VStack>
  );
}

/**
 * An address, domain or host. In the table it never wraps in the middle (web/AGENTS.md, Values
 * never break); in a stacked row it wraps where it must, so the whole value stays on screen.
 */
export function Value({ children }: { children: string }) {
  const stacked = useContext(StackedContext);
  return stacked ? (
    <Text style={WRAP_ANYWHERE}>{children}</Text>
  ) : (
    <Text textWrap="nowrap" style={SELECTABLE}>
      {children}
    </Text>
  );
}
