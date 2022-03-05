import { ReactiveElement, LitElement, html, svg, css } from '/wildtype/lit.js';
import { msg, updateWhenLocaleChanges, getLocale, } from './locales.js';

customElements.define('page-404', class extends LitElement{
	constructor(){
		super();
		updateWhenLocaleChanges(this);
	}
	render(){
		return html`404 not found...${ msg('...', {id:'code'}) }, ${ msg('?', {id: 'lang'}) }`;
	}
});
