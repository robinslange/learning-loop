/**
 * Map selected items.
 * @param  {function} f         Call back function that is called on each item.
 * @param  {number[]} selection Array containing indexes to the selected items.
 * @param  {function} itemFn    Item function to create chainable-methods of the item.
 * @return {Array}              Array of mapped items.
 * @private
 */
var selMap = function ( f, selection, itemFn ) {
  return selection.map( ( item, i ) => f( itemFn( item ), i ) );
}; // selMap()

module.exports = selMap;
