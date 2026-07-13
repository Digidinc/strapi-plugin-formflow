/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */
import type { Core } from '@strapi/strapi';

import type { ExportOptions } from '../../services/export';

/**
 * Re-export the free `ExportOptions` so the EE function signatures below satisfy
 * the TS4082 rule (every type used in an exported declaration must itself be
 * exported from the module). The advanced engine reuses the exact same options
 * the CSV/JSON exporters accept — there is no EE-only option.
 */
export type { ExportOptions };

/**
 * Configuration for a scheduled/emailed export of a form's submissions.
 *
 * One config maps to exactly one Strapi cron entry. The cron emits the export
 * in `format` on the `cronExpression` schedule and emails it as an attachment
 * to every address in `recipientEmails`.
 */
export interface ScheduledExportConfig {
  formId: string;
  format: 'xlsx' | 'pdf' | 'csv';
  cronExpression: string;
  recipientEmails: string[];
}

/**
 * Parse a CSV string (as produced by the free export service) into a row-major
 * array of cell arrays. Handles the BOM prefix, RFC-4180 double-quote escaping,
 * and embedded commas/newlines inside quoted fields. The free exporter is the
 * only producer of this CSV, so the parser only needs to mirror its escaping.
 */
function parseCSV(csv: string): string[][] {
  // Strip the UTF-8 BOM (﻿) the CSV exporter prepends for Excel compat.
  const text = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char === '\r') {
      // Ignore CR; the exporter joins rows with '\n' only.
    } else {
      field += char;
    }
  }

  // Flush the trailing field/row when the CSV does not end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Export a form's submissions to an XLSX workbook.
 *
 * Reuses the free CSV exporter (which already applies field-exclusion, column
 * ordering, and the supplied filters), parses the CSV back into rows, and writes
 * a single-sheet workbook. Returns the workbook as a Buffer. Never throws on
 * entitlement — the 402 gate lives in the controller.
 */
export async function exportToXLSX(
  strapi: Core.Strapi,
  formId: string,
  opts: ExportOptions
): Promise<Buffer> {
  const XLSX = await import('xlsx');
  const exportService = strapi.plugin('formflow').service('export');
  const csv: string = await exportService.exportToCSV(formId, opts);

  const rows = parseCSV(csv);
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Submissions');

  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/**
 * Export a form's submissions to a PDF document.
 *
 * Builds a plain tabular layout — form title header, a column-header row, then
 * one row per submission — from the free CSV exporter's output. No charts, no
 * styling beyond a header/body font weight and English-only labels. Returns the
 * rendered PDF as a Buffer. Never throws on entitlement.
 */
export async function exportToPDF(
  strapi: Core.Strapi,
  formId: string,
  opts: ExportOptions
): Promise<Buffer> {
  const { default: PDFDocument } = await import('pdfkit');
  const exportService = strapi.plugin('formflow').service('export');
  const formService = strapi.plugin('formflow').service('form');

  const [csv, form] = await Promise.all([
    exportService.exportToCSV(formId, opts) as Promise<string>,
    formService.findOne(formId) as Promise<{ title?: string } | null>,
  ]);

  const rows = parseCSV(csv);
  const title = form?.title || 'Submissions';

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Title header.
    doc.fontSize(16).font('Helvetica-Bold').text(title);
    doc.moveDown(0.5);
    doc
      .fontSize(8)
      .font('Helvetica')
      .fillColor('#666666')
      .text(`Exported ${new Date().toISOString()}`);
    doc.fillColor('#000000');
    doc.moveDown(1);

    if (rows.length === 0) {
      doc.fontSize(10).font('Helvetica').text('No submissions.');
      doc.end();
      return;
    }

    const [headerRow, ...dataRows] = rows;
    const columnCount = headerRow.length || 1;
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const columnWidth = pageWidth / columnCount;

    // Render one CSV row as a horizontal band of fixed-width cells. PDFKit lays
    // each cell out at an absolute x with a fixed width so columns stay aligned
    // across wrapping; the band height is the tallest wrapped cell.
    const drawRow = (cells: string[], bold: boolean) => {
      const top = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);

      let maxHeight = 0;
      cells.forEach((cell) => {
        const height = doc.heightOfString(cell, { width: columnWidth - 6 });
        if (height > maxHeight) maxHeight = height;
      });

      cells.forEach((cell, index) => {
        const x = doc.page.margins.left + index * columnWidth;
        doc.text(cell, x + 3, top, { width: columnWidth - 6 });
      });

      doc.y = top + maxHeight + 4;

      // Start a fresh page before the next row when the band would overflow.
      if (doc.y > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
      }
    };

    drawRow(headerRow, true);
    dataRows.forEach((dataRow) => drawRow(dataRow, false));

    doc.end();
  });
}

/**
 * Register a Strapi cron entry that emails a scheduled export of a form's
 * submissions. Named `formflow_scheduled_export_${formId}` so each form has an
 * independent schedule. Re-registering with the same form id replaces the prior
 * entry. Gated on `export.advanced`: an unentitled call is a no-op (registration
 * is silently skipped — the gate never throws).
 */
export async function registerScheduledExport(
  strapi: Core.Strapi,
  config: ScheduledExportConfig
): Promise<void> {
  const licenseService = strapi.plugin('formflow').service('license');
  if (!licenseService.can('export.advanced')) {
    return;
  }

  if (!strapi.cron || typeof strapi.cron.add !== 'function') {
    return;
  }

  const cronName = cronNameFor(config.formId);

  // Replace any existing entry for this form before adding the new schedule.
  try {
    if (typeof strapi.cron.remove === 'function') {
      strapi.cron.remove(cronName);
    }
  } catch {
    // No prior entry — nothing to remove.
  }

  strapi.cron.add({
    [cronName]: {
      options: config.cronExpression,
      async task() {
        try {
          await runScheduledExport(strapi, config);
        } catch (error) {
          strapi.log.error('[FormFlow] Scheduled export failed:', error);
        }
      },
    },
  });
}

/**
 * Remove the scheduled-export cron entry for a form. A no-op when no entry
 * exists or the cron service is unavailable; never throws.
 */
export async function removeScheduledExport(strapi: Core.Strapi, formId: string): Promise<void> {
  try {
    if (strapi.cron && typeof strapi.cron.remove === 'function') {
      strapi.cron.remove(cronNameFor(formId));
    }
  } catch (error) {
    strapi.log.error('[FormFlow] Failed to remove scheduled export cron:', error);
  }
}

/** Cron entry name for a form's scheduled export. */
function cronNameFor(formId: string): string {
  return `formflow_scheduled_export_${formId}`;
}

/**
 * Generate the configured export and email it as an attachment to the
 * recipients. Fire-and-forget: any delivery failure is logged by the caller, no
 * retry. CSV reuses the free exporter; xlsx/pdf use the EE engines above.
 */
async function runScheduledExport(
  strapi: Core.Strapi,
  config: ScheduledExportConfig
): Promise<void> {
  if (!strapi.plugin('formflow').service('license').can('export.advanced')) {
    strapi.log.info('[FormFlow] Scheduled export skipped: Pro entitlement unavailable.');
    return;
  }

  const exportService = strapi.plugin('formflow').service('export');
  const formService = strapi.plugin('formflow').service('form');

  const form = (await formService.findOne(config.formId)) as {
    slug?: string;
    title?: string;
  } | null;
  const dateStr = new Date().toISOString().split('T')[0];
  const baseFilename = `${form?.slug || 'submissions'}-${dateStr}`;

  let content: Buffer;
  let filename: string;
  let contentType: string;

  if (config.format === 'xlsx') {
    content = await exportToXLSX(strapi, config.formId, {});
    filename = `${baseFilename}.xlsx`;
    contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  } else if (config.format === 'pdf') {
    content = await exportToPDF(strapi, config.formId, {});
    filename = `${baseFilename}.pdf`;
    contentType = 'application/pdf';
  } else {
    const csv: string = await exportService.exportToCSV(config.formId, {});
    content = Buffer.from(csv, 'utf8');
    filename = `${baseFilename}.csv`;
    contentType = 'text/csv';
  }

  await strapi.plugins.email.services.email.send({
    to: config.recipientEmails,
    subject: `Scheduled export: ${form?.title || config.formId}`,
    text: `Attached is the latest export of form "${form?.title || config.formId}".`,
    attachments: [{ filename, content, contentType }],
  });

  strapi.log.info(
    `[FormFlow] Scheduled export sent for form "${form?.title || config.formId}" to: ${config.recipientEmails.join(', ')}`
  );
}
