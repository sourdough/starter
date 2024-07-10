import { ReactiveElement, LitElement, html, svg, css,
	msg, updateWhenLocaleChanges, getLocale, } from './deps.js';

customElements.define('page-404', class extends LitElement{
	constructor(){
		super();
		updateWhenLocaleChanges(this);
	}
	render(){
		return html`404 not found...${ msg('...', {id:'code'}) }, ${ msg('?', {id: 'lang'}) }`;
	}
});
