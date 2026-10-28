// The 12 template definitions, shared by the page (live preview) and the export function (PDF/Word), so the
// two can never disagree about a template's colors, fonts or layout style. No DOM, no secrets.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ResumeTemplates = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TEMPLATES = [
    { id:'boardroom', category:'Corporate', name:'The Boardroom', accent:'#1B2B47', accentLight:'#E8EDF3', font:"Georgia,'Times New Roman',serif", style:'centered', bestFor:"Office, administration and business jobs. Classic centered look with a traditional serif font." },
    { id:'partner',   category:'Corporate', name:'The Partner',   accent:'#1B2B47', accentLight:'#E8EDF3', font:"Georgia,'Times New Roman',serif", style:'left-rule', bestFor:"Office work, customer service and first jobs. Plain, traditional and easy to read." },
    { id:'builder',   category:'Tech',      name:'The Builder',   accent:'#3B5168', accentLight:'#E5EBF0', font:"'Helvetica Neue',Helvetica,Arial,sans-serif", style:'modern-left', bestFor:"Office, IT help desk and technical support. Clean, modern sans-serif." },
    { id:'architect', category:'Tech',      name:'The Architect', accent:'#3B5168', accentLight:'#E5EBF0', font:"'Helvetica Neue',Helvetica,Arial,sans-serif", style:'modern-center', bestFor:"Office, administration and technical roles. Clean, centered and modern." },
    { id:'editorial', category:'Creative',  name:'The Editorial', accent:'#A85432', accentLight:'#F5EDE8', accentAlt:'#6B7F5C', accentAltLight:'#EBF0E8', font:"Cambria,Georgia,serif", style:'editorial', bestFor:"Design, writing, marketing and events. A warmer look, with a Clay or Sage color choice.", colorToggle:true },
    { id:'studio',    category:'Creative',  name:'The Studio',    accent:'#A85432', accentLight:'#F5EDE8', accentAlt:'#6B7F5C', accentAltLight:'#EBF0E8', font:"Cambria,Georgia,serif", style:'studio', bestFor:"Beauty, hospitality, events and creative work. Shaded headings, with a Clay or Sage color choice.", colorToggle:true },
    { id:'practitioner', category:'Healthcare', name:'The Practitioner', accent:'#2A6B6E', accentLight:'#E3EEEE', font:"Georgia,serif", style:'centered', bestFor:"Customer service, caregiving, housekeeping and health support. Calm teal, centered." },
    { id:'educator',     category:'Healthcare', name:'The Educator',     accent:'#2A6B6E', accentLight:'#E3EEEE', font:"Georgia,serif", style:'left-rule', bestFor:"Childcare, tutoring, caregiving and first jobs. Calm teal, easy to scan." },
    { id:'scholar',    category:'Academic', name:'The Scholar',   accent:'#6B2737', accentLight:'#F0E8EA', font:"Georgia,'Times New Roman',serif", style:'centered', bestFor:"Students, teaching and academic roles. Education comes first." },
    { id:'researcher', category:'Academic', name:'The Researcher',accent:'#6B2737', accentLight:'#F0E8EA', font:"Georgia,'Times New Roman',serif", style:'left-rule', bestFor:"Research, lab and academic roles. Education comes first." },
    { id:'operator', category:'Trades', name:'The Operator', accent:'#2D2D2D', accentLight:'#EBEBEB', accent2:'#C2511F', font:"'Helvetica Neue',Helvetica,Arial,sans-serif", style:'operator', bestFor:"Retail, warehouse, food service, delivery and first jobs. Bold name, plain and easy to scan." },
    { id:'foreman',  category:'Trades', name:'The Foreman',  accent:'#2D2D2D', accentLight:'#EBEBEB', accent2:'#C2511F', font:"'Helvetica Neue',Helvetica,Arial,sans-serif", style:'foreman', bestFor:"Construction, maintenance, manufacturing and housekeeping. Puts certifications and training first." },
  ];
  const CATEGORIES = ['Corporate','Tech','Creative','Healthcare','Academic','Trades'];
  // What the tabs are called on screen. The ids above are what drafts and exports store, so they stay as they are.
  const CATEGORY_LABELS = { Corporate:'Office & Business', Tech:'Tech', Creative:'Creative', Healthcare:'Care & Service', Academic:'Academic', Trades:'Labor & Trades' };
  const byId = (id) => TEMPLATES.find((t) => t.id === id) || null;
  return { TEMPLATES, CATEGORIES, CATEGORY_LABELS, byId };
});
