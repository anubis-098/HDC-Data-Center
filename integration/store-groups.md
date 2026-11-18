# Store Group / Category

Store codes stay unique and historical shipment, Pallet and Tote records keep their original identifiers. Each Store has a `memberships` array because it can belong to both 1PX and HLE.

```json
{"code":"1","name":"Ladprao","active":true,"memberships":[{"group":"1PX","category":"Combine HLE Direct"},{"group":"HLE","category":"Direct"}]}
```

Data Center publishes these fields in `/api/v1/stores`. Both consumers replicate the array into `stores.memberships` (JSONB) in the same transaction as the name and status. Invalid categories reject the entire snapshot and retain the last successful cache.

## Import

In Data Center, choose the workbook and `Master HLE + Master 1PX` to preview both sheets together. `Master HLE` uses **Group HDC**; `Master 1PX` uses **DC**. Store code/name aliases remain supported. Duplicate identical rows are consolidated. Conflicting names are rejected; case-only differences use the first sheet's spelling.

Importing one sheet updates membership for that sheet's group and preserves membership in the other group. Older files without categories update names and preserve existing memberships. Import keeps existing enabled/disabled statuses and retains Stores absent from the workbook.

Administrators can edit memberships in Data Center's Store editor and filter the list by Group and Category. Consumer Store management pages display these fields and remain read-only.

For local administrator use, `node backend/import-stores.cjs <file.xlsx>` previews counts; append `--apply` to publish. This imports both master sheets, records an audit entry and increments the dataset version. Back up the Data Center database before applying a master import.

## Selection

Container Loading (Pallet editor) and Tote Tracker (dispatch) use one Store selector. Opening it shows collapsed Group headings; expand a Group and Category to reveal its Stores. The search box matches Store code, name and category and shows each matching Store once. Selecting a Store closes the panel. Escape or clicking outside also closes it. A Store belonging to both groups appears under each applicable heading. Only active Stores are selectable. Existing Stores without categories remain under the ungrouped heading, including legacy Pallet selections.

Group/Category filter Store selection; submitted transactions continue to reference the existing Store code. Historical transaction fields are not rewritten when the master data changes.
