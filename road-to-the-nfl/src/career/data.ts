// Team and name data. NFL teams and colleges are real names as text only (no logos, no real
// players). Swap this file for generated names before sharing the game publicly.

export interface TeamInfo {
  name: string;
  short: string;
  primary: string;
  secondary: string;
}

export interface CollegeInfo extends TeamInfo {
  tier: 'major' | 'mid' | 'small';
  conference: string;
}

export const NFL_TEAMS: TeamInfo[] = [
  { name: 'Arizona Cardinals', short: 'ARI', primary: '#97233f', secondary: '#ffb612' },
  { name: 'Atlanta Falcons', short: 'ATL', primary: '#a71930', secondary: '#e8e8e8' },
  { name: 'Baltimore Ravens', short: 'BAL', primary: '#241773', secondary: '#9e7c0c' },
  { name: 'Buffalo Bills', short: 'BUF', primary: '#00338d', secondary: '#c60c30' },
  { name: 'Carolina Panthers', short: 'CAR', primary: '#0085ca', secondary: '#bfc0bf' },
  { name: 'Chicago Bears', short: 'CHI', primary: '#0b162a', secondary: '#c83803' },
  { name: 'Cincinnati Bengals', short: 'CIN', primary: '#fb4f14', secondary: '#111111' },
  { name: 'Cleveland Browns', short: 'CLE', primary: '#311d00', secondary: '#ff3c00' },
  { name: 'Dallas Cowboys', short: 'DAL', primary: '#041e42', secondary: '#a5acaf' },
  { name: 'Denver Broncos', short: 'DEN', primary: '#002244', secondary: '#fb4f14' },
  { name: 'Detroit Lions', short: 'DET', primary: '#0076b6', secondary: '#b0b7bc' },
  { name: 'Green Bay Packers', short: 'GB', primary: '#203731', secondary: '#ffb612' },
  { name: 'Houston Texans', short: 'HOU', primary: '#03202f', secondary: '#a71930' },
  { name: 'Indianapolis Colts', short: 'IND', primary: '#002c5f', secondary: '#e8e8e8' },
  { name: 'Jacksonville Jaguars', short: 'JAX', primary: '#006778', secondary: '#d7a22a' },
  { name: 'Kansas City Chiefs', short: 'KC', primary: '#e31837', secondary: '#ffb81c' },
  { name: 'Las Vegas Raiders', short: 'LV', primary: '#111111', secondary: '#a5acaf' },
  { name: 'Los Angeles Chargers', short: 'LAC', primary: '#0080c6', secondary: '#ffc20e' },
  { name: 'Los Angeles Rams', short: 'LAR', primary: '#003594', secondary: '#ffa300' },
  { name: 'Miami Dolphins', short: 'MIA', primary: '#008e97', secondary: '#fc4c02' },
  { name: 'Minnesota Vikings', short: 'MIN', primary: '#4f2683', secondary: '#ffc62f' },
  { name: 'New England Patriots', short: 'NE', primary: '#002244', secondary: '#c60c30' },
  { name: 'New Orleans Saints', short: 'NO', primary: '#101820', secondary: '#d3bc8d' },
  { name: 'New York Giants', short: 'NYG', primary: '#0b2265', secondary: '#a71930' },
  { name: 'New York Jets', short: 'NYJ', primary: '#125740', secondary: '#e8e8e8' },
  { name: 'Philadelphia Eagles', short: 'PHI', primary: '#004c54', secondary: '#a5acaf' },
  { name: 'Pittsburgh Steelers', short: 'PIT', primary: '#101820', secondary: '#ffb612' },
  { name: 'San Francisco 49ers', short: 'SF', primary: '#aa0000', secondary: '#b3995d' },
  { name: 'Seattle Seahawks', short: 'SEA', primary: '#002244', secondary: '#69be28' },
  { name: 'Tampa Bay Buccaneers', short: 'TB', primary: '#d50a0a', secondary: '#b1babf' },
  { name: 'Tennessee Titans', short: 'TEN', primary: '#0c2340', secondary: '#4b92db' },
  { name: 'Washington Commanders', short: 'WAS', primary: '#5a1414', secondary: '#ffb612' },
];

export const COLLEGES: CollegeInfo[] = [
  { name: 'Alabama', short: 'BAMA', primary: '#9e1b32', secondary: '#e8e8e8', tier: 'major', conference: 'SEC' },
  { name: 'Georgia', short: 'UGA', primary: '#ba0c2f', secondary: '#111111', tier: 'major', conference: 'SEC' },
  { name: 'LSU', short: 'LSU', primary: '#461d7c', secondary: '#fdd023', tier: 'major', conference: 'SEC' },
  { name: 'Texas', short: 'TEX', primary: '#bf5700', secondary: '#e8e8e8', tier: 'major', conference: 'SEC' },
  { name: 'Tennessee', short: 'TENN', primary: '#ff8200', secondary: '#e8e8e8', tier: 'major', conference: 'SEC' },
  { name: 'Florida', short: 'UF', primary: '#0021a5', secondary: '#fa4616', tier: 'major', conference: 'SEC' },
  { name: 'Ohio State', short: 'OSU', primary: '#bb0000', secondary: '#a7b1b7', tier: 'major', conference: 'Big Ten' },
  { name: 'Michigan', short: 'MICH', primary: '#00274c', secondary: '#ffcb05', tier: 'major', conference: 'Big Ten' },
  { name: 'Penn State', short: 'PSU', primary: '#041e42', secondary: '#e8e8e8', tier: 'major', conference: 'Big Ten' },
  { name: 'Oregon', short: 'ORE', primary: '#154733', secondary: '#fee123', tier: 'major', conference: 'Big Ten' },
  { name: 'USC', short: 'USC', primary: '#990000', secondary: '#ffc72c', tier: 'major', conference: 'Big Ten' },
  { name: 'Notre Dame', short: 'ND', primary: '#0c2340', secondary: '#c99700', tier: 'major', conference: 'Independent' },
  { name: 'Clemson', short: 'CLEM', primary: '#f56600', secondary: '#522d80', tier: 'major', conference: 'ACC' },
  { name: 'Miami', short: 'MIA', primary: '#005030', secondary: '#f47321', tier: 'major', conference: 'ACC' },
  { name: 'Oklahoma', short: 'OU', primary: '#841617', secondary: '#fdf9d8', tier: 'major', conference: 'SEC' },
  { name: 'Utah', short: 'UTAH', primary: '#cc0000', secondary: '#e8e8e8', tier: 'major', conference: 'Big 12' },
  { name: 'Boise State', short: 'BSU', primary: '#0033a0', secondary: '#d64309', tier: 'mid', conference: 'Mountain West' },
  { name: 'Memphis', short: 'MEM', primary: '#003087', secondary: '#898d8d', tier: 'mid', conference: 'American' },
  { name: 'Tulane', short: 'TUL', primary: '#006747', secondary: '#41b6e6', tier: 'mid', conference: 'American' },
  { name: 'UCF', short: 'UCF', primary: '#111111', secondary: '#ba9b37', tier: 'mid', conference: 'Big 12' },
  { name: 'Cincinnati', short: 'CIN', primary: '#e00122', secondary: '#111111', tier: 'mid', conference: 'Big 12' },
  { name: 'BYU', short: 'BYU', primary: '#002e5d', secondary: '#e8e8e8', tier: 'mid', conference: 'Big 12' },
  { name: 'San Diego State', short: 'SDSU', primary: '#a6192e', secondary: '#111111', tier: 'mid', conference: 'Mountain West' },
  { name: 'Fresno State', short: 'FRES', primary: '#db0032', secondary: '#002e6d', tier: 'mid', conference: 'Mountain West' },
  { name: 'Toledo', short: 'TOL', primary: '#15397f', secondary: '#ffda00', tier: 'mid', conference: 'MAC' },
  { name: 'Appalachian State', short: 'APP', primary: '#111111', secondary: '#ffcc00', tier: 'mid', conference: 'Sun Belt' },
  { name: 'Liberty', short: 'LIB', primary: '#0a254e', secondary: '#c41230', tier: 'mid', conference: 'Conference USA' },
  { name: 'Utah State', short: 'USU', primary: '#0f2439', secondary: '#8a8d8f', tier: 'mid', conference: 'Mountain West' },
  { name: 'North Dakota State', short: 'NDSU', primary: '#0a5640', secondary: '#ffc72a', tier: 'small', conference: 'Missouri Valley' },
  { name: 'South Dakota State', short: 'SDST', primary: '#0033a0', secondary: '#ffd100', tier: 'small', conference: 'Missouri Valley' },
  { name: 'Montana', short: 'MONT', primary: '#70263d', secondary: '#a7a8aa', tier: 'small', conference: 'Big Sky' },
  { name: 'Montana State', short: 'MSU', primary: '#003875', secondary: '#b9975b', tier: 'small', conference: 'Big Sky' },
  { name: 'Sacramento State', short: 'SAC', primary: '#043927', secondary: '#c4b581', tier: 'small', conference: 'Big Sky' },
  { name: 'Villanova', short: 'NOVA', primary: '#00205b', secondary: '#13b5ea', tier: 'small', conference: 'CAA' },
  { name: 'Furman', short: 'FUR', primary: '#582c83', secondary: '#e8e8e8', tier: 'small', conference: 'SoCon' },
  { name: 'Eastern Washington', short: 'EWU', primary: '#a10022', secondary: '#111111', tier: 'small', conference: 'Big Sky' },
  { name: 'Idaho', short: 'IDHO', primary: '#b3a369', secondary: '#111111', tier: 'small', conference: 'Big Sky' },
  { name: 'Holy Cross', short: 'HC', primary: '#602d89', secondary: '#e8e8e8', tier: 'small', conference: 'Patriot' },
];

export const AFC = new Set(['BAL', 'BUF', 'CIN', 'CLE', 'DEN', 'HOU', 'IND', 'JAX', 'KC', 'LV', 'LAC', 'MIA', 'NE', 'NYJ', 'PIT', 'TEN']);

// Generated names for high schools, rivals and everyone else.
export const TOWNS = [
  'Cedar Ridge', 'Lakeview', 'Pine Hollow', 'Riverside', 'Oak Grove', 'Westbrook', 'Maple Falls', 'Granite City', 'Harbor Point',
  'Clearwater', 'Fox Run', 'Stonebridge', 'Elm Creek', 'Brookfield', 'Summit Hill', 'Red Bluff', 'Silver Lake', 'Kingsport',
  'Northfield', 'Hollis', 'Prairie View', 'Bayside', 'Eastgate', 'Millbrook',
];
export const MASCOTS = [
  'Wildcats', 'Eagles', 'Panthers', 'Bulldogs', 'Hornets', 'Mustangs', 'Rams', 'Falcons', 'Tigers', 'Knights', 'Spartans',
  'Raiders', 'Cougars', 'Bobcats', 'Vikings', 'Lions', 'Hawks', 'Chargers', 'Titans', 'Wolverines',
];
export const HS_COLORS: [string, string][] = [
  ['#7a1f2b', '#f2c14e'], ['#14305c', '#e8e8e8'], ['#1f5130', '#f2f2f2'], ['#4b1f6f', '#f2c14e'], ['#0f3f57', '#f08a24'],
  ['#5a1d1d', '#d9d9d9'], ['#1a1a1a', '#e0a800'], ['#173e7a', '#d33f3f'],
];
export const FIRST = [
  'Jake', 'Mason', 'Tyler', 'Cole', 'Ryan', 'Luke', 'Drew', 'Evan', 'Blake', 'Carson', 'Nate', 'Grant', 'Owen', 'Caleb', 'Brady',
  'Logan', 'Zach', 'Trent', 'Seth', 'Wyatt', 'Reid', 'Chase', 'Hunter', 'Garrett',
];
export const LAST = [
  'Miller', 'Hartley', 'Brooks', 'Sorensen', 'Delgado', 'Fischer', 'Kowalski', 'Lindqvist', 'Marsh', 'Okafor', 'Pruitt', 'Quinn',
  'Ramsey', 'Stroud', 'Tanaka', 'Vance', 'Whitfield', 'Yates', 'Becker', 'Calloway', 'Dunleavy', 'Ellison', 'Ferraro', 'Gentry',
];
