// Text and sticky-comment rendering. The Action posts high findings only; the job summary gets everything.

export function hasHigh(result) {
  return result.changes.some((c) => c.findings.some((f) => f.level === 'high'));
}

export function report(range, { changes, allowed }) {
  const flagged = changes.filter((c) => c.findings.length);
  const lines = [`trustdiff ${range}`, ''];
  for (const c of flagged) {
    const high = c.findings.some((f) => f.level === 'high');
    const where = c.file ? `${c.file}  ` : '';
    lines.push(`${high ? '✖' : '!'} ${where}${c.name} ${c.from.length ? `${c.from.join(', ')} → ` : '(new) '}${c.version}`);
    for (const f of c.findings) lines.push(`    ${f.level.padEnd(4)}  ${f.check.padEnd(20)}  ${f.message}`);
  }
  const highCount = flagged.filter((c) => c.findings.some((f) => f.level === 'high')).length;
  if (flagged.length) lines.push('');
  lines.push(`${changes.length} changed, ${highCount} high-risk, ${flagged.length - highCount} warning, ${changes.length - flagged.length} clean${allowed ? `, ${allowed} allowed` : ''}`);
  return lines.join('\n');
}

// The marker lets the GitHub Action find and update its own PR comment.
export function markdown(body) {
  return `<!-- trustdiff -->\n### trustdiff\n\n${body}\n\n<sub>Acknowledge a reviewed change in \`.trustdiff-allow\`.</sub>`;
}

export function summaryBody(range, result) {
  const high = hasHigh(result);
  const heading = high ? '✖ High-risk trust changes' : '✔ No high-risk trust changes';
  return markdown(`${heading}\n\n\`\`\`\n${report(range, result)}\n\`\`\``);
}

export function commentBody(range, result) {
  const changes = result.changes
    .map((c) => ({ ...c, findings: c.findings.filter((f) => f.level === 'high') }))
    .filter((c) => c.findings.length);
  if (!changes.length) return null;
  const warnings = result.changes.reduce((n, c) => n + c.findings.filter((f) => f.level === 'warn').length, 0);
  let body = `✖ High-risk trust changes\n\n\`\`\`\n${report(range, { changes, allowed: result.allowed })}\n\`\`\``;
  if (warnings) body += `\n\n${warnings} warning${warnings === 1 ? '' : 's'} in the job summary.`;
  return markdown(body);
}

export function clearedComment() {
  return '<!-- trustdiff -->\n### trustdiff\n\n✔ No high-risk trust changes.\n';
}
