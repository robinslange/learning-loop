/**
 * Map for collections.
 * @param  {function} f      Call back function that is called on each item.
 * @param  {number}   start  The start index in the collection.
 * @param  {number}   end    The end index.
 * @param  {function} itemFn Item function to create chainable-methods of the item.
 * @return {Array}           The mapped collection.
 * @private
 */
var colMap = function ( f, start, end, itemFn ) {
  const result = [];
  for ( let k = start; k <= end; k += 1 ) {
    // Use relative indexing by adding `start` from `k`.
    result.push(f( itemFn( k ), ( k - start ) ));
  }
  return result;
};

module.exports = colMap;
