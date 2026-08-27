/**
 * The pieces both phone apps share: the icon set, the press feedback, and the
 * glass surfaces.
 *
 * A package rather than a folder in one app, because the repository forbids one
 * application importing another — and rightly: two copies of an icon set stop
 * matching within a month, and then the customer app and the courier app are
 * visibly two products from two companies.
 */
export * from './icons'
export * from './press-scale'
export * from './glass-surface'
