/** The slate vendor's react, capnweb, puppeteer and node-compat sources, compiled only when a slate starts or a program
 *  that needs one launches: used heap after setup 35.9 to 26.4 MB with lazy compilation (armada 20261007162335-7c145dff). */
export const slateVendorModule = () => import('virtual:kinu-slate-vendor');
