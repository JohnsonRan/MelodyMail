import { useMediaQuery } from "@astryxdesign/core/hooks";
import { VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { type ColumnWidth, Table, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import type { ReactNode } from "react";

export type DataColumn<T> = {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  width?: ColumnWidth;
};

// Below this width the table stacks: each row becomes a list item with its fields one per line.
const STACKED = "(max-width: 640px)";

/**
 * A settings table that spans the frame at desktop width and stacks at phone width, so no value
 * is cut off and nothing scrolls sideways (web/AGENTS.md, Phone width). The first column is the
 * row's label; `actions` sits at the row's end in both layouts.
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
      <List>
        {rows.map((row) => (
          <ListItem
            key={row.id}
            itemKey={row.id}
            align="start"
            label={first?.render(row)}
            description={
              <VStack gap={1}>
                {rest.map((c) => (
                  <VStack key={c.key} gap={0}>
                    <Text type="supporting" color="secondary">
                      {c.header}
                    </Text>
                    {c.render(row)}
                  </VStack>
                ))}
              </VStack>
            }
            endContent={actions?.(row)}
          />
        ))}
      </List>
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

/** An address, domain or host: it never wraps in the middle (web/AGENTS.md, Values never break). */
export function Value({ children }: { children: string }) {
  return <Text textWrap="nowrap">{children}</Text>;
}
